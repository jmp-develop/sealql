import { base64url, concat, decode, frame, unbase64url, utf8 } from './bytes.js';
import { ensure, fail } from './errors.js';
import type { Keyring } from './field-cipher.js';

export interface CursorContext { modelId: string; scopeId: string; keyScopeId: string; queryDigest: string }
export interface CursorPosition { lastId: string; lastSort?: string }
const buffer = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer as ArrayBuffer;
const cursorKeys = new WeakMap<Keyring, Map<string, Promise<CryptoKey>>>();
function key(ring: Keyring, context: CursorContext): Promise<CryptoKey> {
  ensure(ring.keyScopeId === context.keyScopeId, 'KEY_SCOPE_MISMATCH');
  let byModel = cursorKeys.get(ring);
  if (!byModel) { byModel = new Map(); cursorKeys.set(ring, byModel); }
  let pending = byModel.get(context.modelId);
  if (!pending) {
    pending = (async () => {
      const source = await crypto.subtle.importKey('raw', buffer(ring.key), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-384', salt: new Uint8Array(),
        info: buffer(frame(['sealql/cursor/v2', context.modelId, context.keyScopeId])) }, source,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    })();
    byModel.set(context.modelId, pending);
    const map = byModel;
    pending.catch(() => { if (map.get(context.modelId) === pending) map.delete(context.modelId); });
  }
  return pending;
}
const header = new Uint8Array([1]);
const aad = (context: CursorContext) => frame(['sealql/cursor-aad/v2', header, context.modelId, context.keyScopeId, context.scopeId, context.queryDigest]);
export async function sealCursor(context: CursorContext, position: CursorPosition, ring: Keyring): Promise<string> {
  const payload = utf8(JSON.stringify({ queryDigest: context.queryDigest, lastSort: position.lastSort ?? null, lastId: position.lastId }));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(aad(context)), tagLength: 128 }, await key(ring, context), buffer(payload)));
  return base64url(concat(header, nonce, ciphertext));
}
export async function openCursor(encoded: string, context: CursorContext, ring: Keyring): Promise<CursorPosition> {
  try {
    const bytes = unbase64url(encoded);
    ensure(bytes.length >= 29 && bytes[0] === 1, 'CURSOR_INVALID');
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(bytes.slice(1, 13)), additionalData: buffer(aad(context)), tagLength: 128 }, await key(ring, context), buffer(bytes.slice(13))));
    const text = decode(plain), payload = JSON.parse(text) as Record<string, unknown>;
    ensure(Object.keys(payload).sort().join(',') === 'lastId,lastSort,queryDigest', 'CURSOR_INVALID');
    ensure(JSON.stringify(payload) === text && payload.queryDigest === context.queryDigest, 'CURSOR_INVALID');
    ensure(typeof payload.lastId === 'string' && (payload.lastSort === null || typeof payload.lastSort === 'string'), 'CURSOR_INVALID');
    return { lastId: payload.lastId, lastSort: payload.lastSort ?? undefined } as CursorPosition;
  } catch { fail('CURSOR_INVALID'); }
}
