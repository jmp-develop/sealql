import { concat, frame, u32, utf8 } from './bytes.js';
import { ensure, fail } from './errors.js';
import { codecId, codecParameters, codecVersion, decodeField, encodeField, type FieldSpec } from './field-codec.js';

export type Ciphertext = Uint8Array & { readonly __sealqlCiphertext: unique symbol };
export interface SealerSettings { key: Uint8Array; models?: Readonly<Record<string, { key: Uint8Array }>> }
export interface Keyring { keyScopeId: string; key: Uint8Array }
export interface CipherContext { modelId: string; fieldId: string; keyScopeId: string; scopeId: string; rowId: string; spec: FieldSpec }
const buffer = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer as ArrayBuffer;
function checkedBytes(value: string, maxBytes: number): Uint8Array {
  ensure(typeof value === 'string' && !value.includes('\0'), 'INVALID_VALUE');
  const bytes = utf8(value);
  ensure(bytes.length >= 1 && bytes.length <= maxBytes, 'INVALID_VALUE');
  return bytes;
}
function checkedRoot(value: Uint8Array): Uint8Array {
  ensure(value instanceof Uint8Array && value.length === 32, 'INVALID_VALUE');
  return value.slice();
}
interface FieldContext {
  spec: FieldSpec; type: FieldSpec['type']; precision?: number; scale?: number;
  modelId: string; fieldId: string; keyScopeId: string;
  codec: string; codecVersion: number; parameters: Uint8Array;
  aadPrefix: Uint8Array; keyIds: (string | undefined)[];
}
const header = new Uint8Array([3]);
function envelopeShapeInternal(value: unknown, maxBytes: number): asserts value is Ciphertext {
  ensure(value instanceof Uint8Array && value.length >= 29 && value.length <= maxBytes + 29 && value[0] === 3, 'INVALID_CIPHERTEXT');
}
export function envelopeShape(value: unknown, maxBytes = 1048576): asserts value is Ciphertext { envelopeShapeInternal(value, maxBytes); }

export class Sealer {
  private readonly rings = new Map<string, Keyring>();
  private readonly derived = new Map<string, Promise<CryptoKey>>();
  private readonly fieldContexts = new Map<string, FieldContext>();
  constructor(readonly settings: SealerSettings) {
    ensure(settings && typeof settings === 'object', 'INVALID_VALUE');
    this.rings.set('global', { keyScopeId: 'global', key: checkedRoot(settings.key) });
    for (const [modelId, model] of Object.entries(settings.models ?? {})) {
      checkedBytes(modelId, 128);
      ensure(model && typeof model === 'object', 'INVALID_VALUE');
      this.rings.set(`model:${modelId}`, { keyScopeId: `model:${modelId}`, key: checkedRoot(model.key) });
    }
  }
  keyScopeId(modelId: string): string { return this.rings.has(`model:${modelId}`) ? `model:${modelId}` : 'global'; }
  ring(modelId: string): Keyring { return this.rings.get(this.keyScopeId(modelId)) ?? fail('KEY_NOT_FOUND'); }
  private fieldContext(c: CipherContext): FieldContext {
    ensure(typeof c.modelId === 'string' && typeof c.fieldId === 'string' && typeof c.keyScopeId === 'string' &&
      !c.modelId.includes('\0') && !c.fieldId.includes('\0') && !c.keyScopeId.includes('\0'), 'INVALID_VALUE');
    const id = `${c.modelId}\0${c.fieldId}\0${c.keyScopeId}`;
    const cached = this.fieldContexts.get(id);
    const spec = c.spec;
    const precision = spec.type === 'decimal' ? spec.precision : undefined;
    const scale = spec.type === 'decimal' ? spec.scale : undefined;
    if (cached && cached.spec === spec && cached.type === spec.type && cached.precision === precision && cached.scale === scale) return cached;
    checkedBytes(c.modelId, 128); checkedBytes(c.fieldId, 128); checkedBytes(c.keyScopeId, 128);
    const codec = codecId(spec), codecVersionCode = codecVersion(spec), parameters = codecParameters(spec);
    const staticAad = frame(['sealql/aad/v3', header, c.modelId, c.fieldId, codec, u32(codecVersionCode), parameters, c.keyScopeId]);
    const prepared: FieldContext = { spec, type: spec.type, ...(precision === undefined ? {} : { precision }),
      ...(scale === undefined ? {} : { scale }), modelId: c.modelId, fieldId: c.fieldId,
      keyScopeId: c.keyScopeId, codec, codecVersion: codecVersionCode, parameters,
      aadPrefix: concat(u32(10), staticAad.subarray(4)), keyIds: [] };
    this.fieldContexts.set(id, prepared);
    return prepared;
  }
  private shard(rowBytes: Uint8Array): number {
    let hash = 0x811c9dc5;
    for (const byte of rowBytes) hash = Math.imul(hash ^ byte, 0x01000193);
    return hash & 0xff;
  }
  private key(c: FieldContext, shard: number, ring: Keyring): Promise<CryptoKey> {
    const id = c.keyIds[shard] ??= JSON.stringify([c.keyScopeId, c.modelId, c.fieldId, c.codec, c.codecVersion, Array.from(c.parameters), shard]);
    let pending = this.derived.get(id);
    if (!pending) {
      pending = (async () => {
        const material = await crypto.subtle.importKey('raw', buffer(ring.key), 'HKDF', false, ['deriveKey']);
        const info = frame(['sealql/cipher/v3', c.modelId, c.fieldId, c.codec, u32(c.codecVersion), c.parameters, c.keyScopeId, new Uint8Array([shard])]);
        return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-384', salt: new Uint8Array(), info: buffer(info) }, material,
          { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      })();
      this.derived.set(id, pending);
      pending.catch(() => { if (this.derived.get(id) === pending) this.derived.delete(id); });
    }
    return pending;
  }
  private aad(c: FieldContext, scopeBytes: Uint8Array, rowBytes: Uint8Array): Uint8Array {
    const result = new Uint8Array(c.aadPrefix.length + 8 + scopeBytes.length + rowBytes.length);
    result.set(c.aadPrefix);
    const view = new DataView(result.buffer);
    let offset = c.aadPrefix.length;
    view.setUint32(offset, scopeBytes.length); offset += 4;
    result.set(scopeBytes, offset); offset += scopeBytes.length;
    view.setUint32(offset, rowBytes.length); offset += 4;
    result.set(rowBytes, offset);
    return result;
  }
  async seal(value: unknown, context: CipherContext, ring: Keyring): Promise<Ciphertext> {
    ensure(ring.keyScopeId === context.keyScopeId, 'KEY_SCOPE_MISMATCH');
    const prepared = this.fieldContext(context);
    const scopeBytes = checkedBytes(context.scopeId, 1024), rowBytes = checkedBytes(context.rowId, 1024);
    const plain = encodeField(context.spec, value);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
      additionalData: this.aad(prepared, scopeBytes, rowBytes) as Uint8Array<ArrayBuffer>, tagLength: 128 },
    await this.key(prepared, this.shard(rowBytes), ring), plain as Uint8Array<ArrayBuffer>));
    return concat(header, nonce, body) as Ciphertext;
  }
  async open(envelope: Uint8Array, context: CipherContext, ring: Keyring): Promise<unknown> {
    envelopeShapeInternal(envelope, context.spec.maxBytes ?? 65536);
    ensure(ring.keyScopeId === context.keyScopeId, 'KEY_SCOPE_MISMATCH');
    const prepared = this.fieldContext(context);
    const scopeBytes = checkedBytes(context.scopeId, 1024), rowBytes = checkedBytes(context.rowId, 1024);
    let plain: Uint8Array;
    try {
      const bytes = typeof SharedArrayBuffer !== 'undefined' && envelope.buffer instanceof SharedArrayBuffer ? Uint8Array.from(envelope) : envelope;
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13) as Uint8Array<ArrayBuffer>,
        additionalData: this.aad(prepared, scopeBytes, rowBytes) as Uint8Array<ArrayBuffer>, tagLength: 128 },
      await this.key(prepared, this.shard(rowBytes), ring), bytes.subarray(13) as Uint8Array<ArrayBuffer>));
    } catch { fail('AUTHENTICATION_FAILED'); }
    return decodeField(context.spec, plain);
  }
}
export function createSealer(settings: SealerSettings): Sealer { return new Sealer(settings); }
