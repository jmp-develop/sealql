import { compare, utf8 } from './bytes.js';
import { ensure, fail } from './errors.js';
import { encodeField, type FieldSpec, type PlainOf } from './field-codec.js';
import { normalizeText, normalizeWords, searchPieces, searchTokens, type SearchProfile, type SearchTokenCache } from './search-tokens.js';
import type { Keyring } from './field-cipher.js';
import type { SealedModelDefinition } from '../engine/sealed-types.js';

export type SearchOperator = 'eq' | 'contains' | 'startsWith' | 'endsWith' | 'like';
export type SearchNode = { op: SearchOperator; field: string; value: unknown; respectWords?: boolean } | { op: 'all'; children: SearchNode[] } | { op: 'any'; children: SearchNode[] };
type TextOps<S extends FieldSpec> = S extends { search: infer Q } ?
  (Q extends { exact: unknown } ? { eq(value: string): SearchNode } : {}) &
  (Q extends { substring: unknown } ? { contains(value: string, options?: { respectWords?: boolean }): SearchNode; startsWith(value: string): SearchNode; endsWith(value: string): SearchNode; like(value: string): SearchNode } : {}) : {};
export type SearchFields<F extends Record<string, FieldSpec>> = {
  [K in keyof F as F[K] extends { search: false | undefined } ? never : F[K] extends { search: unknown } ? K : never]:
  F[K]['type'] extends 'text' ? TextOps<F[K]> : F[K] extends { search: { exact: unknown } } ? { eq(value: PlainOf<F[K]>): SearchNode } : never;
} & { all(...children: SearchNode[]): SearchNode; any(...children: SearchNode[]): SearchNode };
export function searchFields<F extends Record<string, FieldSpec>>(definition: Pick<SealedModelDefinition, 'fields'>): SearchFields<F> {
  const result: Record<string, unknown> = {
    all: (...children: SearchNode[]) => ({ op: 'all', children }),
    any: (...children: SearchNode[]) => ({ op: 'any', children }),
  };
  for (const [field, spec] of Object.entries(definition.fields)) {
    const search = spec.search;
    if (!search) continue;
    const ops: Record<string, (value: unknown) => SearchNode> = {};
    if ('exact' in search) ops.eq = value => ({ op: 'eq', field, value });
    if ('substring' in search) for (const op of ['contains', 'startsWith', 'endsWith', 'like']) ops[op] = (value: unknown, options?: { respectWords?: boolean }) => ({ op: op as SearchOperator, field, value, ...(op === 'contains' && options?.respectWords ? { respectWords: true } : {}) });
    result[field] = ops;
  }
  return result as SearchFields<F>;
}
const compactSubstring = (value: string, normalizer: string) => normalizeText(value, normalizer).replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, '');
function normalizeLeaf(node: Extract<SearchNode, { field: string }>, spec: FieldSpec, profile: SearchProfile): string | Uint8Array {
  if (spec.type !== 'text') { ensure(node.op === 'eq', 'UNSUPPORTED_SEARCH'); return encodeField(spec, node.value, false); }
  ensure(typeof node.value === 'string' && Array.from(node.value).length <= 256, 'INVALID_VALUE');
  if (node.op === 'like') return node.value;
  const value = profile.mode === 'substring' ? compactSubstring(node.value, profile.normalizer) : normalizeText(node.value, profile.normalizer);
  if (node.op !== 'eq') ensure(Array.from(value).length >= 2, 'QUERY_TOO_BROAD');
  return value;
}
export function validateSearch(node: SearchNode, definition: SealedModelDefinition): void {
  let leaves = 0;
  const visit = (current: SearchNode, depth: number) => {
    ensure(depth <= 8 && current && typeof current === 'object', 'INVALID_VALUE');
    if (current.op === 'all' || current.op === 'any') { ensure(Array.isArray(current.children) && current.children.length > 0, 'INVALID_VALUE'); current.children.forEach(child => visit(child, depth + 1)); return; }
    ensure(++leaves <= 8 && ['eq', 'contains', 'startsWith', 'endsWith', 'like'].includes(current.op), 'INVALID_VALUE');
    const spec = definition.fields[current.field]; ensure(spec?.search, 'UNSUPPORTED_SEARCH');
    ensure(current.op === 'eq' ? 'exact' in spec.search : 'substring' in spec.search, 'UNSUPPORTED_SEARCH');
  };
  visit(node, 1);
}
export interface CompiledLeaf { node: Extract<SearchNode, { field: string }>; profile: SearchProfile; tokens: string[]; normalized: string | Uint8Array }
export type CompiledSearch = { op: 'all'; children: CompiledSearch[] } | { op: 'any'; children: CompiledSearch[] } | { op: 'leaf'; leaf: CompiledLeaf };
export async function compileSearch(node: SearchNode, definition: SealedModelDefinition, storedProfiles: SearchProfile[], ring: Keyring, scopeId: string, tokenCache?: SearchTokenCache, checkpoint: () => void = () => {}): Promise<CompiledSearch> {
  checkpoint();
  if (node.op === 'all' || node.op === 'any') return { op: node.op, children: await Promise.all(node.children.map(child => compileSearch(child, definition, storedProfiles, ring, scopeId, tokenCache, checkpoint))) };
  const spec = definition.fields[node.field]; ensure(spec, 'UNSUPPORTED_SEARCH');
  const mode = node.op === 'eq' ? 'exact' : 'substring';
  const id = spec.id ?? node.field;
  const profile = storedProfiles.find(profile => profile.fieldId === id && profile.mode === mode);
  ensure(profile, 'INVALID_SCHEMA');
  ensure(!node.respectWords || profile.wordBoundary, 'UNSUPPORTED_SEARCH');
  const normalized = normalizeLeaf(node, spec, profile);
  const pieces = node.op === 'like' ? likeAnchors(node.value as string, profile) : searchPieces(profile, node.value, node.op === 'eq' ? 'write' : node.op, node.respectWords);
  ensure(pieces.length > 0 || node.op === 'eq', 'QUERY_TOO_BROAD');
  const tokens = await searchTokens(ring, scopeId, profile, pieces, tokenCache, checkpoint);
  return { op: 'leaf', leaf: { node, profile, tokens, normalized } };
}
function likeAnchors(pattern: string, profile: SearchProfile): Uint8Array[] {
  const runs: string[] = []; let run = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { const next = pattern[++i]; ensure(next === '%' || next === '_' || next === '\\', 'INVALID_VALUE'); run += next; }
    else if (c === '%' || c === '_') { if (run) runs.push(run); run = ''; }
    else run += c;
  }
  if (run) runs.push(run);
  const normalized = runs.map(value => compactSubstring(value, profile.normalizer));
  ensure(normalized.some(value => Array.from(value).length >= 2), 'QUERY_TOO_BROAD');
  return [...new Map(runs.flatMap(value => searchPieces(profile, value, 'contains')).map(value => [Array.from(value).join(','), value])).values()];
}
function likeMatch(value: string, pattern: string, normalizer: string): boolean {
  const tokens: ({ type: 'literal'; value: string } | { type: '%' | '_' })[] = [];
  let run = '';
  const flush = () => { if (run) { for (const c of compactSubstring(run, normalizer)) tokens.push({ type: 'literal', value: c }); run = ''; } };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { const next = pattern[++i]; ensure(next === '%' || next === '_' || next === '\\', 'INVALID_VALUE'); run += next; }
    else if (c === '%' || c === '_') { flush(); tokens.push({ type: c }); }
    else run += c;
  }
  flush();
  const chars = Array.from(value); ensure(chars.length * tokens.length <= 2000000, 'LIMIT_EXCEEDED');
  let prev = new Uint8Array(tokens.length + 1); prev[0] = 1;
  for (let j = 1; j <= tokens.length; j++) prev[j] = tokens[j - 1].type === '%' ? prev[j - 1] : 0;
  for (const char of chars) { const next = new Uint8Array(tokens.length + 1); for (let j = 1; j <= tokens.length; j++) { const token = tokens[j - 1]; next[j] = token.type === '%' ? (prev[j] || next[j - 1]) : token.type === '_' || (token.type === 'literal' && token.value === char) ? prev[j - 1] : 0; } prev = next; }
  return !!prev[tokens.length];
}
export async function verifySearch(compiled: CompiledSearch, get: (field: string) => Promise<unknown>): Promise<boolean> {
  if (compiled.op === 'all') { for (const child of compiled.children) if (!(await verifySearch(child, get))) return false; return true; }
  if (compiled.op === 'any') { for (const child of compiled.children) if (await verifySearch(child, get)) return true; return false; }
  const { node, profile, normalized } = compiled.leaf;
  const value = await get(node.field); if (value === null) return false;
  if (profile.spec.type !== 'text') return value !== undefined && compare(encodeField(profile.spec, value, false), normalized as Uint8Array) === 0;
  ensure(typeof value === 'string', 'AUTHENTICATION_FAILED');
  const text = profile.mode === 'substring' ? compactSubstring(value, profile.normalizer) : normalizeText(value, profile.normalizer);
  switch (node.op) {
    case 'eq': return text === normalized;
    case 'contains': return node.respectWords ? normalizeWords(value).includes(normalizeWords(node.value as string)) : text.includes(normalized as string);
    case 'startsWith': return text.startsWith(normalized as string);
    case 'endsWith': return text.endsWith(normalized as string);
    case 'like': return likeMatch(text, node.value as string, profile.normalizer);
  }
}
