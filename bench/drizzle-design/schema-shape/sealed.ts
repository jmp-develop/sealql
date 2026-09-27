// Feasibility prototype for a "register-after-the-fact" sealed-column API.
// No crypto, no DB: Sealed<T> just carries the plaintext so the shape can be
// type-checked and exercised with drizzle.mock(). See bench/drizzle-design/proto.ts
// for the prior (upfront sealedTable()) design this one departs from.
import {
  customType, index, primaryKey, foreignKey, bigint, uuid, text, pgTable,
  type PgColumn, type PgTable, type PgDatabase,
} from 'drizzle-orm/pg-core';
import {
  and, eq, getTableColumns, getTableName,
  type InferInsertModel, type InferSelectModel,
} from 'drizzle-orm';

declare const sealedBrand: unique symbol;
declare const sealMetaSym: unique symbol;

/** Opaque "sealed" handle. Prototype only: holds the plaintext, no bytes/crypto. */
export class Sealed<T> {
  declare readonly [sealedBrand]: T;
  private constructor(readonly plain: T) {}
  static wrap<T>(plain: T): Sealed<T> { return new Sealed(plain); }
  toJSON(): never { throw new Error('SEAL_NOT_OPENED: call sealed.open() first'); }
  toString(): never { throw new Error('SEAL_NOT_OPENED: call sealed.open() first'); }
}

// ---------- sealed.text / sealed.integer builders ----------

type SearchSpec = { exact?: boolean; substring?: boolean };
type FieldOpts = { nullable?: boolean; search?: SearchSpec; column?: string };
interface FieldSpec { kind: 'text' | 'integer'; nullable: boolean; search: SearchSpec }
interface FieldBinding { key: string; column: PgColumn; spec: FieldSpec }
interface SealRegistration<T extends PgTable = PgTable> {
  parent: T; row: string; scope?: string; fields: Map<string, FieldBinding>;
}

/** guard function -> spec. Attached to the column via $defaultFn so it survives builder->column build (same trick as proto.ts). */
const fieldSpecs = new WeakMap<Function, FieldSpec>();
/** companion table -> registration (also lets insert/update/upsert recover the real parent table + field bindings). */
const registrations = new WeakMap<object, SealRegistration>();

function mkBuilder<T>(dbName: string) {
  return customType<{ data: Sealed<T>; driverData: string }>({
    dataType: () => 'bytea',
    toDriver(value) {
      if (!(value instanceof Sealed)) throw new Error('SEAL_REQUIRED: raw plaintext written to a sealed column');
      return JSON.stringify((value as Sealed<T>).plain);
    },
    fromDriver(value) { return Sealed.wrap(JSON.parse(String(value))) as Sealed<T>; },
  })(dbName);
}
type B<T> = ReturnType<typeof mkBuilder<T>>;
type SealedField<T, O extends FieldOpts | undefined> =
  O extends { nullable: true } ? B<T> : ReturnType<B<T>['notNull']>;

function sealedColumn<T>(kind: 'text' | 'integer') {
  return function build<const O extends FieldOpts>(key: string, opts?: O): SealedField<T, O> {
    const dbName = opts?.column ?? `${key}_ct`;
    const spec: FieldSpec = { kind, nullable: !!opts?.nullable, search: opts?.search ?? {} };
    const guard = () => { throw new Error(`SEAL_REQUIRED: "${key}" must be written through sealed.insert/update/upsert`); };
    fieldSpecs.set(guard, spec);
    let b: any = mkBuilder<T>(dbName);
    b = opts?.nullable ? b.$defaultFn(guard) : b.notNull().$defaultFn(guard);
    return b as SealedField<T, O>;
  };
}

// ---------- register(table, { row, scope }) ----------

type ColumnsOf<T extends PgTable> = T['_']['columns'];
/** Keys of T's OWN (non-sealed) columns whose Postgres type is uuid or text. */
export type UuidOrTextKeys<T extends PgTable> = {
  [K in keyof ColumnsOf<T>]: ColumnsOf<T>[K]['_']['columnType'] extends 'PgUUID' | 'PgText' ? K : never;
}[keyof ColumnsOf<T>] & string;

type SealMeta<T extends PgTable, R extends string, S extends string | undefined> = {
  readonly [sealMetaSym]?: { parent: T; row: R; scope: S };
};
function mirrorColumn(col: PgColumn, name: string) {
  return col.getSQLType() === 'uuid' ? uuid(name) : text(name);
}

/**
 * Walks the already-built table's columns, finds the sealed.text/integer ones
 * (via the $defaultFn guard planted by sealedColumn), binds JS-key -> column,
 * and builds the companion `<table>_seal` posting table (row_id/scope_id +
 * one bigint[] per search profile + GIN/btree indexes + FK ... ON DELETE CASCADE).
 */
export function register<
  T extends PgTable,
  R extends UuidOrTextKeys<T>,
  S extends UuidOrTextKeys<T> | undefined = undefined,
>(table: T, cfg: { row: R; scope?: S }) {
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  const fields = new Map<string, FieldBinding>();
  for (const [key, col] of Object.entries(cols)) {
    const guard = (col as unknown as { defaultFn?: Function }).defaultFn;
    if (guard && fieldSpecs.has(guard)) fields.set(key, { key, column: col, spec: fieldSpecs.get(guard)! });
  }
  if (fields.size === 0) throw new Error(`sealed.register(${getTableName(table)}): no sealed.text/integer columns found`);
  const rowCol = cols[cfg.row as string];
  const scopeCol = cfg.scope ? cols[cfg.scope as string] : undefined;
  if (!rowCol) throw new Error(`sealed.register: unknown row key "${String(cfg.row)}"`);
  const parentName = getTableName(table);

  const companionCols: Record<string, any> = {};
  if (scopeCol) companionCols.scopeId = mirrorColumn(scopeCol, 'scope_id').notNull();
  companionCols.rowId = mirrorColumn(rowCol, 'row_id').notNull();
  const substringKeys: string[] = [];
  for (const [key, f] of fields) {
    if (f.spec.search.exact) companionCols[`${key}Exact`] = bigint(`${key}_exact`, { mode: 'bigint' }).array();
    if (f.spec.search.substring) {
      companionCols[`${key}Substring`] = bigint(`${key}_substring`, { mode: 'bigint' }).array();
      substringKeys.push(`${key}Substring`);
    }
  }

  const companion = pgTable(`${parentName}_seal`, companionCols, (t: any) => {
    const out: any[] = [];
    if (scopeCol) {
      out.push(primaryKey({ columns: [t.scopeId, t.rowId] }));
      out.push(foreignKey({ columns: [t.scopeId, t.rowId], foreignColumns: [scopeCol, rowCol] }).onDelete('cascade'));
    } else {
      out.push(primaryKey({ columns: [t.rowId] }));
      out.push(foreignKey({ columns: [t.rowId], foreignColumns: [rowCol] }).onDelete('cascade'));
    }
    for (const [key, f] of fields) {
      if (f.spec.search.exact) out.push(index(`${parentName}_seal_${key}_exact`).using('btree', t[`${key}Exact`]));
    }
    if (substringKeys.length) {
      const ginCols = substringKeys.map(k => t[k]) as [any, ...any[]];
      out.push(index(`${parentName}_seal_gin`).using('gin', ...ginCols));
    }
    return out;
  });

  registrations.set(companion, { parent: table, row: cfg.row as string, scope: cfg.scope as string | undefined, fields });
  return companion as typeof companion & SealMeta<T, R, S>;
}

/** Debug/verification helper: the runtime key->column bindings register() found. */
export function fieldsOf(seal: object): ReadonlyMap<string, FieldBinding> {
  return requireReg(seal).fields;
}

// ---------- insert / update / upsert / open ----------

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type SealedKeys<T extends PgTable> = {
  [K in keyof InferSelectModel<T>]: NonNullable<InferSelectModel<T>[K]> extends Sealed<any> ? K : never;
}[keyof InferSelectModel<T>];
type Unseal<V> = V extends Sealed<infer P> ? P : V;

/** Plain insert/patch shape for T: Sealed<P> fields replaced by P (optional+nullable iff the column is nullable). */
export type PlainShape<T extends PgTable> = Simplify<
  { [K in Exclude<keyof InferInsertModel<T>, SealedKeys<T>>]: InferInsertModel<T>[K] } &
  { [K in SealedKeys<T> as null extends InferSelectModel<T>[K] ? never : K]: Unseal<InferSelectModel<T>[K]> } &
  { [K in SealedKeys<T> as null extends InferSelectModel<T>[K] ? K : never]?: Unseal<InferSelectModel<T>[K]> | null }
>;

/** Structural deep open: every Sealed<P> -> P. Works for any select/join/relational result shape. */
export type Opened<R> =
  R extends Sealed<infer P> ? P :
  R extends Date | Uint8Array | string | number | bigint | boolean | null | undefined ? R :
  R extends readonly (infer E)[] ? Opened<E>[] :
  R extends object ? { [K in keyof R]: Opened<R[K]> } : R;

function requireReg(seal: object): SealRegistration {
  const reg = registrations.get(seal);
  if (!reg) throw new Error('sealed: second argument was not returned by sealed.register()');
  return reg;
}

function prepareRow(reg: SealRegistration, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const key of reg.fields.keys()) {
    if (!(key in out)) continue;
    const v = out[key];
    out[key] = v === null || v === undefined ? v : Sealed.wrap(v);
  }
  return out;
}

// NOTE: T/R/S are inferred by matching `seal`'s actual (intersection) type against the
// SealMeta<T,R,S> shape directly -- NOT by pulling C through ParentOf/RowKeyOf/ScopeKeyOf
// after the fact. The latter (an earlier version of this file) type-checked in isolation
// (`type X = ParentOf<typeof customersSearch>` resolved fine) but silently stopped
// catching @ts-expect-error cases at real call sites: with a naked `C extends object` and
// `PlainShape<ParentOf<C>>` computed from it, TS defers the nested conditional-type lookup
// during argument checking and never re-validates the object literal against it, so wrong
// types / missing fields / excess properties all slipped through uncaught. Inferring
// T/R/S directly (ordinary generic inference, not post-hoc `infer` extraction) does not
// have this problem.
export async function insert<T extends PgTable, R extends string, S extends string | undefined = undefined>(
  db: PgDatabase<any, any, any>,
  seal: SealMeta<T, R, S> & object,
  rows: PlainShape<T> | PlainShape<T>[],
) {
  const reg = requireReg(seal);
  const arr = Array.isArray(rows) ? rows : [rows];
  const prepared = arr.map(r => prepareRow(reg, r as Record<string, unknown>));
  return db.insert(reg.parent).values(prepared as any);
}

type IdentityKeys<R extends string, S extends string | undefined> = R | Exclude<S, undefined>;

export async function update<T extends PgTable, R extends string, S extends string | undefined = undefined>(
  db: PgDatabase<any, any, any>,
  seal: SealMeta<T, R, S> & object,
  identity: Simplify<Pick<InferInsertModel<T>, IdentityKeys<R, S> & keyof InferInsertModel<T>>>,
  patch: Partial<Omit<PlainShape<T>, IdentityKeys<R, S>>>,
) {
  const reg = requireReg(seal);
  const cols = getTableColumns(reg.parent) as Record<string, PgColumn>;
  const prepared = prepareRow(reg, patch as Record<string, unknown>);
  const conditions = Object.entries(identity as Record<string, unknown>).map(([k, v]) => eq(cols[k], v as never));
  return db.update(reg.parent).set(prepared as any).where(and(...conditions));
}

export async function upsert<T extends PgTable, R extends string, S extends string | undefined = undefined>(
  db: PgDatabase<any, any, any>,
  seal: SealMeta<T, R, S> & object,
  row: PlainShape<T>,
) {
  const reg = requireReg(seal);
  const cols = getTableColumns(reg.parent) as Record<string, PgColumn>;
  const prepared = prepareRow(reg, row as Record<string, unknown>);
  const target = reg.scope ? [cols[reg.scope], cols[reg.row]] : [cols[reg.row]];
  return db.insert(reg.parent).values(prepared as any).onConflictDoUpdate({ target: target as any, set: prepared as any });
}

export async function open<R>(rows: R): Promise<Opened<R>> {
  const walk = (v: any): any => {
    if (v instanceof Sealed) return v.plain;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Uint8Array)) {
      const out: any = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(rows) as Opened<R>;
}

export const sealed = {
  text: sealedColumn<string>('text'),
  integer: sealedColumn<number>('integer'),
  register,
  insert,
  update,
  upsert,
  open,
};
