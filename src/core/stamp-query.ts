import { hex, utf8 } from './bytes.js';
import { ensure } from './errors.js';
import type { Keyring } from './field-cipher.js';
import { compactText, exactBytes, stampKey } from './search-stamps.js';
import { type SearchProfile } from './search-tokens.js';
export type LikePart = '%' | '_' | { text: string };
export type ProofPattern = ('%' | '_' | { k: number[]; o: number[]; n: number })[];
export interface StampQuery { keys: Uint8Array[]; offsets: number[]; length: number; pattern?: ProofPattern }
export function parseLike(pattern: string, profile: SearchProfile): LikePart[] {
  const result: LikePart[] = []; let run = '';
  const flush = () => { if (run) { const text = compactText(run, profile); if (text) result.push({ text }); run = ''; } };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { const next = pattern[++i]; ensure(next === '%' || next === '_' || next === '\\', 'INVALID_VALUE'); run += next; }
    else if (c === '%' || c === '_') { flush(); if (c !== '%' || result.at(-1) !== '%') result.push(c); }
    else run += c;
  }
  flush();
  const literals = result.filter((part): part is { text: string } => typeof part !== 'string');
  ensure(literals.length > 0 && literals.every(part => Array.from(part.text).length >= 2), 'QUERY_TOO_BROAD');
  return result;
}
const windows = (length: number) => {
  const result: number[] = [];
  for (let i = 0; i + 2 <= length; i += 2) result.push(i);
  if (result.at(-1) !== length - 2) result.push(length - 2);
  return result;
};
export async function compileStampQuery(ring: Keyring, profile: SearchProfile, scope: string,
  node: { op: string; value: unknown }): Promise<StampQuery> {
  if (node.op === 'eq') return { keys: [await stampKey(ring, profile, 'exact', scope, exactBytes(profile, node.value))], offsets: [], length: 0 };
  const keys: Uint8Array[] = [], cache = new Map<string, number>();
  const run = async (text: string) => {
    const chars = Array.from(text);
    ensure(chars.length >= 2, 'QUERY_TOO_BROAD');
    const offsets = windows(chars.length), ids: number[] = [];
    for (const offset of offsets) {
      const piece = chars.slice(offset, offset + 2).join('');
      const stream = 'compact2';
      const id = `${stream}:${piece}`;
      let index = cache.get(id);
      if (index === undefined) {
        index = keys.length; cache.set(id, index);
        keys.push(await stampKey(ring, profile, stream, scope, utf8(piece)));
      }
      ids.push(index);
    }
    return { k: ids, o: offsets, n: chars.length };
  };
  if (node.op === 'like') {
    const pattern: ProofPattern = [];
    for (const part of parseLike(node.value as string, profile)) pattern.push(typeof part === 'string' ? part : await run(part.text));
    return { keys, offsets: [], length: 0, pattern };
  }
  const part = await run(compactText(node.value as string, profile));
  // Position requests carry one key and an independent forward cursor per window.
  return { keys: part.k.map(index => keys[index]), offsets: part.o, length: part.n };
}
/** PostgreSQL text-array encoding, independent of pg/postgres-js bytea[] adapters. */
export const keyArray = (keys: Uint8Array[]): string => `{${keys.map(key => `"\\\\x${hex(key)}"`).join(',')}}`;
/** Flat LIKE program: -1=%; -2=_; otherwise [length, windowCount, keyId+1, offset, ...]. */
export const patternProgram = (pattern: ProofPattern): number[] => pattern.flatMap(part =>
  part === '%' ? [-1] : part === '_' ? [-2] : [part.n, part.k.length, ...part.k.flatMap((key, i) => [key+1, part.o[i]])]);
