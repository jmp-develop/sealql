import { frame, hex, u32, utf8 } from './bytes.js';
import { ensure } from './errors.js';
import { codecId, codecParameters, codecVersion, encodeField, type FieldSpec, type SearchProtection } from './field-codec.js';
import type { Keyring } from './field-cipher.js';

export type SearchMode = 'exact' | 'substring';
export interface SearchProfile {
  modelId: string; fieldId: string; indexId: string; spec: FieldSpec;
  mode: SearchMode; bits: number;
  normalizer: string; protection?: SearchProtection; wordBoundary?: boolean; skipGrams?: boolean;
}
const buffer = (v: Uint8Array): ArrayBuffer => Uint8Array.from(v).buffer as ArrayBuffer;
const whitespace = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
export const compactText = (value: string, profile: Pick<SearchProfile, 'normalizer'>): string => normalizeText(value, profile.normalizer).replace(whitespace, '');
const fold = (value: string) => value.normalize('NFC').replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xff01 + 0x21)).replace(/[A-Z]/g, c => c.toLowerCase());
export function normalizeText(value: string, normalizer: string): string {
  utf8(value);
  let s = fold(value);
  if (normalizer === 'nfc-v1') return s;
  ensure(normalizer === 'legacy-text-v1' || normalizer === 'phone-v1', 'INVALID_SCHEMA');
  s = s.replace(whitespace, '');
  if (normalizer === 'legacy-text-v1') return s;
  s = s.replace(/[-().]/g, '').replace(/^\+/, '');
  ensure(/^[0-9]*$/.test(s) && (value === '' || s !== ''), 'INVALID_VALUE');
  return s;
}
export function normalizeWords(value: string): string {
  return fold(value).replace(whitespace, ' ').replace(/ +/g, ' ').trim();
}
/** Bit width for an exact-value index with an expected maximum of P distinct values. */
export function exactBitsForPopulation(population: number): number {
  ensure(Number.isSafeInteger(population) && population >= 512, 'INVALID_VALUE');
  return Math.max(8, Math.min(32, Math.floor(Math.log2(population)) - 1));
}
export function profiles(modelId: string, fieldId: string, spec: FieldSpec, defaultProtection: SearchProtection = 'standard'): SearchProfile[] {
  const search = spec.search;
  if (!search) return [];
  ensure((search.protection ?? defaultProtection) === 'standard', 'INVALID_SCHEMA');
  const normalizer = spec.type === 'text' ? (search as { normalizer?: string }).normalizer ?? 'legacy-text-v1' : '';
  return (['exact', 'substring'] as const).flatMap(mode => {
    const option = mode in search ? (search as Record<string, unknown>)[mode] : undefined;
    if (!option) return [];
    const bits = mode === 'substring' ? 16 : option === true ? 16 : (option as { bits?: number }).bits ?? 16;
    const words: { wordBoundary?: boolean; skipGrams?: boolean } = mode === 'substring' && option !== true ? option as { wordBoundary?: boolean; skipGrams?: boolean } : {};
    return [{ modelId, fieldId, indexId: `${fieldId}/${mode}`, spec, mode, bits, normalizer, protection: 'standard' as const,
      ...words, ...(mode === 'substring' ? { skipGrams: words.skipGrams !== false } : {}) }];
  });
}
export function descriptorBytes(p: SearchProfile): Uint8Array {
  ensure(Number.isInteger(p.bits) && p.bits >= 2 && p.bits <= 32 && (p.mode !== 'substring' || p.bits === 16), 'INVALID_SCHEMA');
  return frame([p.modelId, p.fieldId, p.indexId, codecId(p.spec), u32(codecVersion(p.spec)), codecParameters(p.spec), p.normalizer, p.mode, u32(p.bits), p.wordBoundary ? 'word' : '', p.skipGrams ? 'skip' : '']);
}
const piece = (kind: string, value: string): Uint8Array => frame([kind, utf8(value)]);
export function searchPieces(p: SearchProfile, value: unknown, operation: 'write' | 'contains' | 'startsWith' | 'endsWith' = 'write', respectWords = false): Uint8Array[] {
  if (p.spec.type !== 'text') { ensure(p.mode === 'exact', 'UNSUPPORTED_SEARCH'); return [encodeField(p.spec, value, false)]; }
  ensure(typeof value === 'string', 'INVALID_VALUE');
  const normalized = p.mode === 'substring' ? compactText(value, p) : normalizeText(value, p.normalizer);
  const chars = Array.from(normalized);
  if (p.mode === 'exact') return [utf8(normalized)];
  if (chars.length < 2) return [];
  const result: Uint8Array[] = [];
  for (let i = 0; i + 1 < chars.length; i++) result.push(piece('adjacent', chars[i] + chars[i + 1]));
  if (operation === 'write' || operation === 'startsWith') result.push(piece('start', chars[0]));
  if (operation === 'write' || operation === 'endsWith') result.push(piece('end', chars.at(-1)!));
  if (p.skipGrams) for (let i = 0; i + 2 < chars.length; i++) result.push(piece('skip', chars[i] + chars[i + 2]));
  if (p.wordBoundary && (operation === 'write' || respectWords)) {
    const words = normalizeWords(value).split(' ').filter(Boolean).map(word => Array.from(word));
    words.forEach((letters, index) => {
      if (operation === 'write' || index > 0) result.push(piece('word-start', letters[0]));
      if (operation === 'write' || index < words.length - 1) result.push(piece('word-end', letters.at(-1)!));
    });
  }
  return [...new Map(result.map(bytes => [hex(bytes), bytes])).values()];
}
export interface SearchTokenCache {
  profiles: Map<string, Promise<CryptoKey>>;
}
export async function searchTokens(ring: Keyring, scopeId: string, p: SearchProfile, pieces: readonly Uint8Array[], cache?: SearchTokenCache, checkpoint: () => void = () => {}): Promise<string[]> {
  if (!pieces.length) return [];
  checkpoint();
  const cacheId = hex(frame([ring.keyScopeId, descriptorBytes(p)]));
  let pendingKey = cache?.profiles.get(cacheId);
  if (!pendingKey) {
    pendingKey = (async () => {
      const material = await crypto.subtle.importKey('raw', buffer(ring.key), 'HKDF', false, ['deriveBits']);
      const keyBytes = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-384', salt: new Uint8Array(), info: buffer(frame(['sealql/index/v3', ring.keyScopeId, descriptorBytes(p)])) }, material, 384);
      return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-384' }, false, ['sign']);
    })();
    cache?.profiles.set(cacheId, pendingKey);
    if (cache) { const profileCache = cache.profiles; pendingKey.catch(() => { if (profileCache.get(cacheId) === pendingKey) profileCache.delete(cacheId); }); }
  }
  const key = await pendingKey;
  const scope = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer(frame(['scope', scopeId])))).subarray(0, 4);
  let prefix = 0n; for (const byte of scope) prefix = (prefix << 8n) | BigInt(byte);
  const result = new Set<bigint>(); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, pieces.length) }, async () => {
    while (cursor < pieces.length) {
      checkpoint();
      const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer(frame(['value', scopeId, pieces[cursor++]]))));
      const raw = new DataView(digest.buffer).getUint32(0);
      const bits = p.bits === 32 ? raw : (raw >>> (32 - p.bits)) * 2 ** (32 - p.bits);
      result.add(BigInt.asIntN(64, (prefix << 32n) | BigInt(bits >>> 0)));
    }
  }));
  return [...result].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(String);
}
