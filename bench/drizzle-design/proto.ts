// Throwaway prototype of the plan/001 public shapes (types + minimal runtime, no crypto).
import { customType, index, uniqueIndex, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { getTableColumns, getTableName, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';

declare const sealedBrand: unique symbol;
declare const tokenBrand: unique symbol;
/** Opaque ciphertext handle. T = plaintext type. */
export class Sealed<T, R extends string = string> {
  declare readonly [sealedBrand]: [T, R];
  constructor(readonly bytes: Uint8Array, readonly meta: FieldMeta) {}
  toJSON(): never { throw new Error('SEAL_NOT_OPENED'); }
  toString(): never { throw new Error('SEAL_NOT_OPENED'); }
}
export class SealTokens { declare readonly [tokenBrand]: true; constructor(readonly raw: unknown) {} }
interface FieldMeta { def: SealDef<any, any, any, any>; key: string }

type FieldSpec = { type: 'text' | 'integer'; nullable?: boolean; search?: { exact?: boolean; substring?: boolean } };
type Plain<S extends FieldSpec> = S['type'] extends 'text' ? string : number;
type TokenKeys<F extends Record<string, FieldSpec>> = {
  [K in keyof F & string]: F[K]['search'] extends { exact: true } ? `__seal_${K}_e` : never }[keyof F & string]
  | { [K in keyof F & string]: F[K]['search'] extends { substring: true } ? `__seal_${K}_s` : never }[keyof F & string];

function sealedCol<T, R extends string>(meta: FieldMeta) {
  return customType<{ data: Sealed<T, R>; driverData: Uint8Array | string }>({
    dataType: () => 'bytea',
    toDriver(value) {
      if (!(value instanceof Sealed)) throw new Error('SEAL_REQUIRED'); // runtime guard
      return value.bytes;
    },
    fromDriver(value) {
      const bytes = typeof value === 'string' ? Uint8Array.from((value.replace(/^\\x/, '').match(/../g) ?? []).map(h => parseInt(h, 16))) : new Uint8Array(value);
      return new Sealed<T, R>(bytes, meta);
    },
  });
}
const tokenCol = <N extends string>(n: N) => customType<{ data: SealTokens; driverData: string | string[] }>({
  dataType: () => 'bigint[]',
  toDriver(v) { if (!(v instanceof SealTokens)) throw new Error('SEAL_REQUIRED'); return v.raw as string; },
  fromDriver(v) { return new SealTokens(v); }, // identity: no per-element BigInt work
})(n);
export const marker = new WeakMap<Function, FieldMeta>();

function mk<T, R extends string>(meta: FieldMeta, name: string) { return sealedCol<T, R>(meta)(name); }
type B<T, R extends string> = ReturnType<typeof mk<T, R>>;
type Cols<F extends Record<string, FieldSpec>, R extends string> = {
  [K in keyof F & string]: F[K]['nullable'] extends true ? B<Plain<F[K]>, R> : ReturnType<B<Plain<F[K]>, R>['notNull']>
} & { [K in TokenKeys<F>]: ReturnType<typeof tokenCol<string>> };
export interface SealDef<M extends string, R extends string, S extends string | undefined, F extends Record<string, FieldSpec>> {
  model: M; row: R; scope: S; fields: F;
  readonly columns: Cols<F, R>;
  indexes(t: Record<string, PgColumn>): any[];
}
export function sealedTable<const M extends string, const R extends string, const S extends string | undefined = undefined, const F extends Record<string, FieldSpec> = {}>(
  model: M, cfg: { row: R; scope?: S; fields: F }): SealDef<M, R, S, F> {
  const def: any = { model, row: cfg.row, scope: cfg.scope, fields: cfg.fields };
  Object.defineProperty(def, 'columns', { get() {
    const out: Record<string, any> = {};
    for (const [key, spec] of Object.entries(cfg.fields)) {
      const meta = { def, key };
      const guard = () => { throw new Error('SEAL_REQUIRED'); };
      marker.set(guard, meta);
      let b: any = mk(meta, `${key}_ct`);
      b = spec.nullable ? b.$defaultFn(guard) : b.notNull().$defaultFn(guard);
      out[key] = b;
      if (spec.search?.exact) out[`__seal_${key}_e`] = tokenCol(`${key}_tok_e`).$defaultFn(guard);
      if (spec.search?.substring) out[`__seal_${key}_s`] = tokenCol(`${key}_tok_s`).$defaultFn(guard);
    }
    return out;
  } });
  def.indexes = (t: Record<string, PgColumn>) => {
    const table = getTableName((t[cfg.row] as any).table);
    const subs = Object.keys(cfg.fields).filter(k => cfg.fields[k].search?.substring).map(k => t[`__seal_${k}_s`]);
    const exact = Object.keys(cfg.fields).filter(k => cfg.fields[k].search?.exact);
    const scopeCols = cfg.scope ? [t[cfg.scope]] : [];
    return [
      uniqueIndex(`${table}_seal_row`).on(...(scopeCols as [PgColumn]), t[cfg.row]),
      ...exact.map(k => index(`${table}_seal_${k}_e`).on(...(scopeCols as [PgColumn]), sql`(${t[`__seal_${k}_e`]})[1]`, t[cfg.row])),
      ...(subs.length ? [index(`${table}_seal_gin`).using('gin', subs[0], ...subs.slice(1))] : []),
    ];
  };
  return def;
}

// ---------- type machinery for seal / patch / open (no Drizzle internals beyond Infer*Model) ----------
type DefOf<T> = T extends { _: { columns: infer C } } ? C : never;
type SealedKeys<T extends PgTable> = { [K in keyof InferSelectModel<T>]: NonNullable<InferSelectModel<T>[K]> extends Sealed<any> ? K : never }[keyof InferSelectModel<T>];
type TokKeys<T extends PgTable> = { [K in keyof InferSelectModel<T>]: NonNullable<InferSelectModel<T>[K]> extends SealTokens ? K : never }[keyof InferSelectModel<T>];
type Unseal<V> = V extends Sealed<infer P, any> ? P : V;
type RowKey<T extends PgTable> = { [K in keyof InferSelectModel<T>]: NonNullable<InferSelectModel<T>[K]> extends Sealed<any, infer R> ? R : never }[keyof InferSelectModel<T>];
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type SealInput<T extends PgTable, R extends string> = Simplify<
  { [K in Exclude<keyof InferInsertModel<T>, SealedKeys<T> | TokKeys<T> | R>]: InferInsertModel<T>[K] } &
  { [K in R & keyof InferInsertModel<T>]?: string } &
  { [K in SealedKeys<T> as null extends InferSelectModel<T>[K] ? never : K]: Unseal<InferSelectModel<T>[K]> } &
  { [K in SealedKeys<T> as null extends InferSelectModel<T>[K] ? K : never]?: Unseal<InferSelectModel<T>[K]> | null }>;
export type SealOutput<T extends PgTable, R extends string> = Simplify<InferInsertModel<T> & { [K in R & keyof InferInsertModel<T>]-?: string }>;

/** Structural deep open: every Sealed<P> -> P, every SealTokens key removed. Works for any result shape. */
export type Opened<R> =
  R extends Sealed<infer P, any> ? P :
  R extends Date | Uint8Array | string | number | bigint | boolean | null | undefined ? R :
  R extends readonly (infer E)[] ? Opened<E>[] :
  R extends object ? { [K in keyof R as NonNullable<R[K]> extends SealTokens ? never : K]: Opened<R[K]> } : R;

export interface SealedApi {
  seal<T extends PgTable>(table: T, row: SealInput<T, RowKey<T>>): Promise<InferInsertModel<T>>;
  seal<T extends PgTable>(table: T, rows: SealInput<T, RowKey<T>>[]): Promise<InferInsertModel<T>[]>;
  patch<T extends PgTable>(table: T, identity: Record<string, string>, changes: Partial<{ [K in keyof InferSelectModel<T> as K extends TokKeys<T> ? never : K]: Unseal<InferSelectModel<T>[K]> }>): Promise<Partial<InferInsertModel<T>>>;
  open<R>(rows: R): Promise<Opened<R>>;
}
export const sealed = {} as SealedApi;
export function findMeta(table: PgTable) {
  for (const col of Object.values(getTableColumns(table)) as PgColumn[]) if (col.defaultFn && marker.has(col.defaultFn)) return marker.get(col.defaultFn)!;
  return undefined;
}
