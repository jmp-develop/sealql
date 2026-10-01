import { ensure } from './errors.js';
import { encodeField, type FieldSpec } from './field-codec.js';
import { compactText, normalizeText, searchPieces, searchTokens, type SearchProfile, type SearchTokenCache } from './search-tokens.js';
import type { Keyring } from './field-cipher.js';
import type { SealedModelDefinition } from './sealed-model.js';
import { compileStampQuery, normalizeLike, parseLike, type StampQuery } from './stamp-query.js';

export type SearchOperator = 'eq' | 'contains' | 'startsWith' | 'endsWith' | 'like';
export type SearchNode = { op: SearchOperator; field: string; value: unknown } | { op: 'all'; children: SearchNode[] } | { op: 'any'; children: SearchNode[] };
const compactSubstring = (value: string, normalizer: string) => compactText(value, { normalizer });
function normalizeLeaf(node: Extract<SearchNode, { field: string }>, spec: FieldSpec, profile: SearchProfile): string | Uint8Array {
  if (spec.type !== 'text') { ensure(node.op === 'eq', 'UNSUPPORTED_SEARCH'); return encodeField(spec, node.value, false); }
  ensure(typeof node.value === 'string', 'INVALID_VALUE');
  if (node.op === 'like') return node.value;
  const value = profile.mode === 'substring' ? compactSubstring(node.value, profile.normalizer) : normalizeText(node.value, profile.normalizer);
  if (node.op !== 'eq') ensure(Array.from(value).length >= 2, 'QUERY_TOO_BROAD');
  return value;
}
export function validateSearch(node: SearchNode, definition: SealedModelDefinition): void {
  const visit = (current: SearchNode) => {
    ensure(current && typeof current === 'object', 'INVALID_VALUE');
    if (current.op === 'all' || current.op === 'any') { ensure(Array.isArray(current.children) && current.children.length > 0, 'INVALID_VALUE'); current.children.forEach(visit); return; }
    ensure(['eq', 'contains', 'startsWith', 'endsWith', 'like'].includes(current.op), 'INVALID_VALUE');
    const spec = definition.fields[current.field]; ensure(spec?.search, 'UNSUPPORTED_SEARCH');
    ensure(current.op === 'eq' ? 'exact' in spec.search : 'substring' in spec.search, 'UNSUPPORTED_SEARCH');
  };
  visit(node);
}
export interface CompiledLeaf { node: Extract<SearchNode, { field: string }>; profile: SearchProfile; tokens: string[]; normalized: string | Uint8Array; proof: StampQuery }
export type CompiledSearch = { op: 'all'; children: CompiledSearch[] } | { op: 'any'; children: CompiledSearch[] } | { op: 'leaf'; leaf: CompiledLeaf };
export async function compileSearch(node: SearchNode, definition: SealedModelDefinition, storedProfiles: SearchProfile[], ring: Keyring, scopeId: string, tokenCache?: SearchTokenCache, checkpoint: () => void = () => {}): Promise<CompiledSearch> {
  checkpoint();
  if (node.op === 'all' || node.op === 'any') return { op: node.op, children: await Promise.all(node.children.map(child => compileSearch(child, definition, storedProfiles, ring, scopeId, tokenCache, checkpoint))) };
  const spec = definition.fields[node.field]; ensure(spec, 'UNSUPPORTED_SEARCH');
  const mode = node.op === 'eq' ? 'exact' : 'substring';
  const id = spec.id ?? node.field;
  const profile = storedProfiles.find(profile => profile.fieldId === id && profile.mode === mode);
  ensure(profile, 'INVALID_SCHEMA');
  const normalized = normalizeLeaf(node, spec, profile);
  const simpleLike = node.op === 'like' ? normalizeLike(node.value as string, profile) : undefined;
  const pieces = simpleLike ? searchPieces(profile, simpleLike.value, simpleLike.op)
    : node.op === 'like' ? likeAnchors(node.value as string, profile) : searchPieces(profile, node.value, node.op === 'eq' ? 'write' : node.op);
  ensure(pieces.length > 0 || node.op === 'eq', 'QUERY_TOO_BROAD');
  const tokens = profile.hardened ? [] : await searchTokens(ring, scopeId, profile, pieces, tokenCache, checkpoint);
  const proof = await compileStampQuery(ring, profile, scopeId, node);
  return { op: 'leaf', leaf: { node, profile, tokens, normalized, proof } };
}
function likeAnchors(pattern: string, profile: SearchProfile): Uint8Array[] {
  const runs = parseLike(pattern, profile).filter((part): part is { text: string } => typeof part !== 'string');
  return [...new Map(runs.flatMap(({ text }) => searchPieces(profile, text, 'contains')).map(value => [Array.from(value).join(','), value])).values()];
}
