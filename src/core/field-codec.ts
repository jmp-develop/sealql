import { decode, utf8 } from './bytes.js';
import { ensure, fail } from './errors.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SearchProtection = 'standard';
export type SearchIndex = true | { bits?: number };
export type SubstringIndex = true | { wordBoundary?: boolean; skipGrams?: boolean };
export type TextSearch = ({ exact: SearchIndex; substring?: SubstringIndex } | { exact?: SearchIndex; substring: SubstringIndex }) & { normalizer?: 'nfc-v1' | 'legacy-text-v1' | 'phone-v1'; protection?: SearchProtection };
export interface PlainValidator<T> { id: string; version: number; check(value: T): boolean }
type Common<T> = { id?: string; validate?: PlainValidator<T>; maxBytes?: number };
export type FieldSpec =
  | (Common<string> & { type: 'text'; search?: false | TextSearch })
  | (Common<number> & { type: 'integer'; search?: false | { exact: SearchIndex; protection?: SearchProtection } })
  | (Common<bigint> & { type: 'bigint'; search?: false | { exact: SearchIndex; protection?: SearchProtection } })
  | (Common<string> & { type: 'decimal'; precision: number; scale: number; search?: false | { exact: SearchIndex; protection?: SearchProtection } })
  | (Common<boolean> & { type: 'boolean'; search?: false })
  | (Common<Date> & { type: 'instant'; search?: false })
  | (Common<JsonValue> & { type: 'json'; search?: false })
  | (Common<Uint8Array> & { type: 'bytes'; search?: false });
export type PlainOf<F extends FieldSpec> = F['type'] extends 'integer' ? number : F['type'] extends 'bigint' ? bigint : F['type'] extends 'boolean' ? boolean : F['type'] extends 'instant' ? Date : F['type'] extends 'json' ? JsonValue : F['type'] extends 'bytes' ? Uint8Array : string;
const ascii = (s: string) => utf8(s);
const decimal = (value: unknown, precision: number, scale: number): string => {
  ensure(Number.isInteger(precision) && precision >= 1 && precision <= 1000 && Number.isInteger(scale) && scale >= 0 && scale <= precision, 'INVALID_SCHEMA');
  ensure(typeof value === 'string' && /^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(value), 'INVALID_VALUE');
  const sign = value[0] === '-' ? '-' : '';
  const raw = value.replace(/^[+-]/, '').split('.');
  ensure((raw[1]?.length ?? 0) <= scale, 'INVALID_VALUE');
  const whole = raw[0].replace(/^0+(?=[0-9])/, '');
  ensure(whole.length <= precision - scale || (precision === scale && whole === '0'), 'INVALID_VALUE');
  const fraction = (raw[1] ?? '').padEnd(scale, '0');
  const zero = whole === '0' && !/[1-9]/.test(fraction);
  return `${zero ? '' : sign}${whole}${scale ? `.${fraction}` : ''}`;
};
function jsonGuard(value: unknown, seen = new Set<object>(), depth = 0, count = { n: 0 }): asserts value is JsonValue {
  ensure(depth <= 64 && ++count.n <= 10000, 'LIMIT_EXCEEDED');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { if (typeof value === 'string') utf8(value); return; }
  if (typeof value === 'number') { ensure(Number.isFinite(value), 'INVALID_VALUE'); return; }
  ensure(typeof value === 'object' && !seen.has(value), 'INVALID_VALUE');
  seen.add(value);
  try {
    if (Array.isArray(value)) { for (const item of value) jsonGuard(item, seen, depth + 1, count); return; }
    ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'INVALID_VALUE');
    ensure(Object.getOwnPropertySymbols(value).length === 0, 'INVALID_VALUE');
    for (const key of Object.keys(value)) { utf8(key); jsonGuard((value as Record<string, unknown>)[key], seen, depth + 1, count); }
  } finally { seen.delete(value); }
}
export function validateField(spec: FieldSpec): void {
  ensure(spec && typeof spec === 'object', 'INVALID_SCHEMA');
  ensure(['text', 'integer', 'bigint', 'decimal', 'boolean', 'instant', 'json', 'bytes'].includes(spec.type), 'INVALID_SCHEMA');
  if (spec.id !== undefined) ensure(typeof spec.id === 'string' && utf8(spec.id).length > 0 && utf8(spec.id).length <= 128 && !spec.id.includes('/'), 'INVALID_SCHEMA');
  if (spec.maxBytes !== undefined) ensure(Number.isInteger(spec.maxBytes) && spec.maxBytes > 0 && spec.maxBytes <= 1048576, 'INVALID_SCHEMA');
  if (spec.type === 'decimal') decimal('0', spec.precision, spec.scale);
  if (spec.validate) ensure(typeof spec.validate.id === 'string' && spec.validate.id.length > 0 && Number.isInteger(spec.validate.version) && spec.validate.version > 0 && typeof spec.validate.check === 'function', 'INVALID_SCHEMA');
  const search = spec.search;
  if (search && typeof search === 'object') {
    ensure(['text', 'integer', 'bigint', 'decimal'].includes(spec.type), 'INVALID_SCHEMA');
    ensure(search.exact !== undefined || ('substring' in search && search.substring !== undefined), 'INVALID_SCHEMA');
    for (const [key, value] of Object.entries(search)) {
      ensure(['exact', 'substring', 'normalizer', 'protection'].includes(key), 'INVALID_SCHEMA');
      if (key === 'protection') { ensure(value === 'standard', 'INVALID_SCHEMA'); continue; }
      if (key === 'normalizer') { ensure(spec.type === 'text' && ['nfc-v1', 'legacy-text-v1', 'phone-v1'].includes(value as string), 'INVALID_SCHEMA'); continue; }
      if (key === 'substring') {
        ensure(spec.type === 'text' && (value === true || (value && typeof value === 'object' && Object.keys(value).every(k => ['wordBoundary', 'skipGrams'].includes(k)) && Object.values(value).every(v => typeof v === 'boolean'))), 'INVALID_SCHEMA');
      } else ensure(value === true || (value && typeof value === 'object' && Number.isInteger((value as { bits?: number }).bits ?? 16) && ((value as { bits?: number }).bits ?? 16) >= 8 && ((value as { bits?: number }).bits ?? 16) <= 32), 'INVALID_SCHEMA');
    }
  }
}
export function codecId(spec: FieldSpec): string { return spec.type; }
export function codecVersion(spec: FieldSpec): number { return spec.type === 'text' ? 2 : 1; }
export function codecParameters(spec: FieldSpec): Uint8Array { return spec.type === 'decimal' ? ascii(`${spec.precision}:${spec.scale}`) : new Uint8Array(); }
export function encodeField(spec: FieldSpec, value: unknown, writing = true): Uint8Array {
  let bytes: Uint8Array;
  switch (spec.type) {
    case 'text': ensure(typeof value === 'string', 'INVALID_VALUE'); bytes = utf8(value); break;
    case 'integer': ensure(typeof value === 'number' && Number.isSafeInteger(value), 'INVALID_VALUE'); bytes = ascii(Object.is(value, -0) ? '0' : String(value)); break;
    case 'bigint': ensure(typeof value === 'bigint' && value.toString().replace('-', '').length <= 4096, 'INVALID_VALUE'); bytes = ascii(value.toString()); break;
    case 'decimal': bytes = ascii(decimal(value, spec.precision, spec.scale)); break;
    case 'boolean': ensure(typeof value === 'boolean', 'INVALID_VALUE'); bytes = new Uint8Array([value ? 1 : 0]); break;
    case 'instant': ensure(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_VALUE'); bytes = ascii(String(value.getTime())); break;
    case 'json': jsonGuard(value); bytes = utf8(JSON.stringify(value)); break;
    case 'bytes': ensure(value instanceof Uint8Array, 'INVALID_VALUE'); bytes = value.slice(); break;
  }
  ensure(bytes.length <= (spec.maxBytes ?? 65536) && bytes.length <= 1048576, 'LIMIT_EXCEEDED');
  if (writing && spec.validate) { try { ensure(spec.validate.check(value as never) === true, 'VALIDATION_FAILED'); } catch { fail('VALIDATION_FAILED'); } }
  return bytes;
}
export function decodeField(spec: FieldSpec, bytes: Uint8Array): unknown {
  ensure(bytes instanceof Uint8Array && bytes.length <= (spec.maxBytes ?? 65536), 'INVALID_CIPHERTEXT');
  let value: unknown;
  switch (spec.type) {
    case 'text': value = decode(bytes); break;
    case 'integer': { const s = decode(bytes); ensure(/^(?:0|-?[1-9][0-9]*)$/.test(s), 'INVALID_CIPHERTEXT'); value = Number(s); break; }
    case 'bigint': { const s = decode(bytes); ensure(/^(?:0|-?[1-9][0-9]*)$/.test(s) && s.replace('-', '').length <= 4096, 'INVALID_CIPHERTEXT'); value = BigInt(s); break; }
    case 'decimal': value = decode(bytes); break;
    case 'boolean': ensure(bytes.length === 1 && (bytes[0] === 0 || bytes[0] === 1), 'INVALID_CIPHERTEXT'); value = bytes[0] === 1; break;
    case 'instant': { const s = decode(bytes); ensure(/^(?:0|-?[1-9][0-9]*)$/.test(s), 'INVALID_CIPHERTEXT'); value = new Date(Number(s)); break; }
    case 'json': { try { value = JSON.parse(decode(bytes)); } catch { fail('INVALID_CIPHERTEXT'); } break; }
    case 'bytes': value = bytes.slice(); break;
  }
  try { const canonical = encodeField(spec, value, false); ensure(canonical.length === bytes.length && canonical.every((b, i) => b === bytes[i]), 'INVALID_CIPHERTEXT'); } catch { fail('INVALID_CIPHERTEXT'); }
  return value;
}
