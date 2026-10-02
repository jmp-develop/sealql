import { decode, utf8 } from './bytes.js';
import { ensure, fail } from './errors.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SearchProtection = 'standard';
export type SearchIndex = true | { bits?: number };
export type SubstringIndex = true | { skipGrams?: boolean };
export type TextSearch = ({ exact: SearchIndex; substring?: SubstringIndex } | { exact?: SearchIndex; substring: SubstringIndex }) & { normalizer?: 'digits' | 'keep-spaces'; protection?: SearchProtection };
export interface PlainValidator<T> { id: string; version: number; check(value: T): boolean }
type Common<T> = { id?: string; validate?: PlainValidator<T>; maxBytes?: number; hardened?: true };
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
  ensure(Number.isSafeInteger(precision) && precision >= 1 && Number.isSafeInteger(scale) && scale >= 0 && scale <= precision, 'INVALID_SCHEMA');
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
function jsonGuard(value: unknown): asserts value is JsonValue {
  const active = new Set<object>();
  const stack: { value: unknown; exit?: boolean }[] = [{ value }];
  while (stack.length) {
    const next = stack.pop()!;
    const part = next.value;
    if (next.exit) { active.delete(part as object); continue; }
    if (part === null || typeof part === 'boolean') continue;
    if (typeof part === 'string') { utf8(part); continue; }
    if (typeof part === 'number') { ensure(Number.isFinite(part), 'INVALID_VALUE'); continue; }
    ensure(typeof part === 'object' && !active.has(part), 'INVALID_VALUE');
    active.add(part);
    stack.push({ value: part, exit: true });
    if (Array.isArray(part)) {
      for (let i = part.length - 1; i >= 0; i--) stack.push({ value: part[i] });
    } else {
      ensure(Object.getPrototypeOf(part) === Object.prototype || Object.getPrototypeOf(part) === null, 'INVALID_VALUE');
      ensure(Object.getOwnPropertySymbols(part).length === 0, 'INVALID_VALUE');
      for (const key of Object.keys(part).reverse()) { utf8(key); stack.push({ value: (part as Record<string, unknown>)[key] }); }
    }
  }
}
function stringifyJson(value: JsonValue): string {
  const output: string[] = [];
  const stack: ({ value: JsonValue } | { text: string })[] = [{ value }];
  while (stack.length) {
    const part = stack.pop()!;
    if ('text' in part) { output.push(part.text); continue; }
    const item = part.value;
    if (item === null || typeof item !== 'object') { output.push(JSON.stringify(item)); continue; }
    if (Array.isArray(item)) {
      output.push('[');
      stack.push({ text: ']' });
      for (let i = item.length - 1; i >= 0; i--) {
        stack.push({ value: item[i] });
        if (i > 0) stack.push({ text: ',' });
      }
    } else {
      output.push('{');
      stack.push({ text: '}' });
      const entries = Object.entries(item);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        stack.push({ value: child });
        stack.push({ text: ':' });
        stack.push({ text: JSON.stringify(key) });
        if (i > 0) stack.push({ text: ',' });
      }
    }
  }
  return output.join('');
}
export function validateField(spec: FieldSpec): void {
  ensure(spec && typeof spec === 'object', 'INVALID_SCHEMA');
  ensure(['text', 'integer', 'bigint', 'decimal', 'boolean', 'instant', 'json', 'bytes'].includes(spec.type), 'INVALID_SCHEMA');
  if (spec.id !== undefined) ensure(typeof spec.id === 'string' && utf8(spec.id).length > 0 && !spec.id.includes('/'), 'INVALID_SCHEMA');
  if (spec.maxBytes !== undefined) ensure(Number.isSafeInteger(spec.maxBytes) && spec.maxBytes > 0, 'INVALID_SCHEMA');
  if (spec.type === 'decimal') decimal('0', spec.precision, spec.scale);
  if (spec.validate) ensure(typeof spec.validate.id === 'string' && spec.validate.id.length > 0 && Number.isInteger(spec.validate.version) && spec.validate.version > 0 && typeof spec.validate.check === 'function', 'INVALID_SCHEMA');
  const search = spec.search;
  if (spec.hardened !== undefined) ensure(spec.hardened === true && !!search && typeof search === 'object', 'INVALID_SCHEMA');
  if (search && typeof search === 'object') {
    ensure(['text', 'integer', 'bigint', 'decimal'].includes(spec.type), 'INVALID_SCHEMA');
    ensure(search.exact !== undefined || ('substring' in search && search.substring !== undefined), 'INVALID_SCHEMA');
    for (const [key, value] of Object.entries(search)) {
      ensure(['exact', 'substring', 'normalizer', 'protection'].includes(key), 'INVALID_SCHEMA');
      if (key === 'protection') { ensure(value === 'standard', 'INVALID_SCHEMA'); continue; }
      if (key === 'normalizer') { ensure(spec.type === 'text' && ['digits', 'keep-spaces'].includes(value as string), 'INVALID_SCHEMA'); continue; }
      if (key === 'substring') {
        ensure(spec.type === 'text' && (value === true || (value && typeof value === 'object' && Object.keys(value).every(k => ['skipGrams'].includes(k)) && Object.values(value).every(v => typeof v === 'boolean'))), 'INVALID_SCHEMA');
      } else ensure(value === true || (value && typeof value === 'object' && Number.isInteger((value as { bits?: number }).bits ?? 16) && ((value as { bits?: number }).bits ?? 16) >= 2 && ((value as { bits?: number }).bits ?? 16) <= 32), 'INVALID_SCHEMA');
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
    case 'bigint': ensure(typeof value === 'bigint', 'INVALID_VALUE'); bytes = ascii(value.toString()); break;
    case 'decimal': bytes = ascii(decimal(value, spec.precision, spec.scale)); break;
    case 'boolean': ensure(typeof value === 'boolean', 'INVALID_VALUE'); bytes = new Uint8Array([value ? 1 : 0]); break;
    case 'instant': ensure(value instanceof Date && Number.isFinite(value.getTime()), 'INVALID_VALUE'); bytes = ascii(String(value.getTime())); break;
    case 'json': jsonGuard(value); bytes = utf8(stringifyJson(value)); break;
    case 'bytes': ensure(value instanceof Uint8Array, 'INVALID_VALUE'); bytes = value.slice(); break;
  }
  ensure(bytes.length <= (spec.maxBytes ?? Infinity), 'LIMIT_EXCEEDED');
  if (writing && spec.validate) { try { ensure(spec.validate.check(value as never) === true, 'VALIDATION_FAILED'); } catch { fail('VALIDATION_FAILED'); } }
  return bytes;
}
export function decodeField(spec: FieldSpec, bytes: Uint8Array): unknown {
  ensure(bytes instanceof Uint8Array && bytes.length <= (spec.maxBytes ?? Infinity), 'INVALID_CIPHERTEXT');
  let value: unknown;
  switch (spec.type) {
    case 'text': value = decode(bytes); break;
    case 'integer': { const s = decode(bytes); ensure(/^(?:0|-?[1-9][0-9]*)$/.test(s), 'INVALID_CIPHERTEXT'); value = Number(s); break; }
    case 'bigint': { const s = decode(bytes); ensure(/^(?:0|-?[1-9][0-9]*)$/.test(s), 'INVALID_CIPHERTEXT'); value = BigInt(s); break; }
    case 'decimal': value = decode(bytes); break;
    case 'boolean': ensure(bytes.length === 1 && (bytes[0] === 0 || bytes[0] === 1), 'INVALID_CIPHERTEXT'); value = bytes[0] === 1; break;
    case 'instant': { const s = decode(bytes); ensure(/^(?:0|-?[1-9][0-9]*)$/.test(s), 'INVALID_CIPHERTEXT'); value = new Date(Number(s)); break; }
    case 'json': { try { value = JSON.parse(decode(bytes)); } catch { fail('INVALID_CIPHERTEXT'); } break; }
    case 'bytes': value = bytes.slice(); break;
  }
  try { const canonical = encodeField(spec, value, false); ensure(canonical.length === bytes.length && canonical.every((b, i) => b === bytes[i]), 'INVALID_CIPHERTEXT'); } catch { fail('INVALID_CIPHERTEXT'); }
  return value;
}
