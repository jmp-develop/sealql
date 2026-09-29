import { hex, utf8 } from './bytes.js';
import { ensure } from './errors.js';
import type { Keyring } from './field-cipher.js';
import { compactText, exactBytes, stampKey } from './search-stamps.js';
import { normalizeWords, type SearchProfile } from './search-tokens.js';
export type LikePart = '%' | '_' | { text: string };
export type ProofPattern = ('%' | '_' | { k: number[]; o: number[]; n: number })[];
export interface StampQuery { keys: Uint8Array[]; kinds: number[]; offsets: number[]; length: number; pattern?: ProofPattern }
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
  ensure(result.some(part => typeof part !== 'string' && Array.from(part.text).length >= 2), 'QUERY_TOO_BROAD');
  return result;
}
const windows = (length: number) => {
  const result: number[] = [];
  for (let i = 0; i + 2 <= length; i += 2) result.push(i);
  if (result.at(-1) !== length - 2) result.push(length - 2);
  return result;
};
export async function compileStampQuery(ring: Keyring, profile: SearchProfile, scope: string,
  node: { op: string; value: unknown; respectWords?: boolean }): Promise<StampQuery> {
  if (node.op === 'eq') return { keys: [await stampKey(ring, profile, 'exact', scope, exactBytes(profile, node.value))], kinds: [], offsets: [], length: 0 };
  const keys: Uint8Array[] = [], kinds: number[] = [], cache = new Map<string, number>();
  const run = async (text: string, words = false) => {
    const chars = Array.from(text), singleton = chars.length === 1;
    const offsets = singleton ? [0] : windows(chars.length), ids: number[] = [];
    for (const offset of offsets) {
      const piece = chars.slice(offset, offset + (singleton ? 1 : 2)).join('');
      const stream = singleton ? 'single1' : words ? 'words2' : 'compact2';
      const id = `${stream}:${piece}`;
      let index = cache.get(id);
      if (index === undefined) {
        index = keys.length; cache.set(id, index);
        keys.push(await stampKey(ring, profile, stream, scope, utf8(piece))); kinds.push(singleton ? 1 : 2);
      }
      ids.push(index);
    }
    return { k: ids, o: offsets, n: chars.length };
  };
  if (node.op === 'like') {
    const pattern: ProofPattern = [];
    for (const part of parseLike(node.value as string, profile)) pattern.push(typeof part === 'string' ? part : await run(part.text));
    return { keys, kinds, offsets: [], length: 0, pattern };
  }
  const text = node.respectWords ? normalizeWords(node.value as string) : compactText(node.value as string, profile);
  const part = await run(text, node.respectWords);
  // Position requests carry one key per window; the SQL function deduplicates repeated keys.
  return { keys: part.k.map(index => keys[index]), kinds: [], offsets: part.o, length: part.n };
}
/** PostgreSQL text-array encoding, independent of pg/postgres-js bytea[] adapters. */
export const keyArray = (keys: Uint8Array[]): string => `{${keys.map(key => `"\\\\x${hex(key)}"`).join(',')}}`;
