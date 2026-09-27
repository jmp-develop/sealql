import { getTableColumns, getTableName, is, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  bigint, customType, foreignKey, getTableConfig, index, pgSchema, pgTable, primaryKey, uniqueIndex,
  text, uuid, PgCustomColumn, type PgColumn, type PgTable,
} from 'drizzle-orm/pg-core';
import { unhex } from '../../../core/bytes.js';
import { companionIndexName, companionProfiles } from '../../../core/companion-layout.js';
import { ensure, fail } from '../../../core/errors.js';
import { envelopeShape, type Sealer } from '../../../core/field-cipher.js';
import { validateField, type FieldSpec, type JsonValue } from '../../../core/field-codec.js';
import type { SealedModelDefinition, SealedStorage } from '../../../core/sealed-model.js';
import { runtimeMethods } from './native-runtime.js';

declare const sealedBrand: unique symbol;
declare const sealMetaBrand: unique symbol;

export class Sealed<T, S = false> {
  declare private readonly [sealedBrand]: { value: T; search: S };
  private constructor(readonly bytes: Uint8Array, readonly binding: FieldBinding | undefined) {}
  static fromDriver<T, S>(value: unknown, binding: FieldBinding | undefined): Sealed<T, S> {
    const bytes = typeof value === 'string' ? unhex(value.startsWith('\\x') ? value.slice(2) : value) : new Uint8Array(value as Uint8Array);
    envelopeShape(bytes);
    return new Sealed<T, S>(bytes, binding);
  }
  static forWrite<T, S>(bytes: Uint8Array, binding: FieldBinding): Sealed<T, S> {
    envelopeShape(bytes);
    const value = new Sealed<T, S>(bytes, binding);
    writable.add(value);
    return value;
  }
  static releaseWrite(value: Sealed<unknown, unknown>): void { writable.delete(value); }
  toJSON(): never { return fail('SEAL_REQUIRED'); }
  toString(): never { return fail('SEAL_REQUIRED'); }
}
const writable = new WeakSet<object>();

export type Opened<R> = R extends Sealed<infer T, any> ? T :
  R extends Date | Uint8Array | string | number | bigint | boolean | null | undefined ? R :
  R extends readonly (infer E)[] ? Opened<E>[] :
  R extends object ? { [K in keyof R]: Opened<R[K]> } : R;

type SearchOf<F extends FieldSpec> = F extends { search?: infer S } ? S : false;
type Options<F extends FieldSpec> = Omit<F, 'type'> & { nullable?: boolean; column?: string };
type TextOptions = Options<Extract<FieldSpec, { type: 'text' }>>;
type IntegerOptions = Options<Extract<FieldSpec, { type: 'integer' }>>;
type BigintOptions = Options<Extract<FieldSpec, { type: 'bigint' }>>;
type DecimalOptions = Options<Extract<FieldSpec, { type: 'decimal' }>>;
type BooleanOptions = Options<Extract<FieldSpec, { type: 'boolean' }>>;
type InstantOptions = Options<Extract<FieldSpec, { type: 'instant' }>>;
type JsonOptions = Options<Extract<FieldSpec, { type: 'json' }>>;
type BytesOptions = Options<Extract<FieldSpec, { type: 'bytes' }>>;
type Builder<T, S> = ReturnType<ReturnType<typeof customType<{ data: Sealed<T, S>; driverData: Uint8Array }>>>;
type NullableBuilder<T, S, O> = O extends { nullable: true } ? Builder<T, S> : ReturnType<Builder<T, S>['notNull']>;

interface FieldBinding { key: string; column: PgColumn; spec: FieldSpec & { nullable: boolean }; registration: Registration }
interface PendingField { name: string; spec: FieldSpec & { nullable: boolean }; bind?: FieldBinding }
export interface Registration {
  parent: PgTable; index: PgTable; row: string; scope?: string; rowUnique: boolean; model: string;
  fields: Map<string, FieldBinding>; definition: SealedModelDefinition; storage: SealedStorage;
}
const pendingFields = new WeakMap<Function, PendingField>();
const registrations = new WeakMap<object, Registration>();

type SealedKeys<T extends PgTable> = {
  [K in keyof InferSelectModel<T>]: NonNullable<InferSelectModel<T>[K]> extends Sealed<any, any> ? K : never;
}[keyof InferSelectModel<T>];
type Unseal<V> = V extends Sealed<infer P, any> ? P : V;
export type PlainShape<T extends PgTable> = {
  [K in Exclude<keyof InferInsertModel<T>, SealedKeys<T>>]: InferInsertModel<T>[K]
} & {
  [K in SealedKeys<T> as null extends InferSelectModel<T>[K] ? never : K]-?: Unseal<InferSelectModel<T>[K]>
} & {
  [K in SealedKeys<T> as null extends InferSelectModel<T>[K] ? K : never]?: Unseal<InferSelectModel<T>[K]> | null
};
export type UuidOrTextKeys<T extends PgTable> = {
  [K in keyof T['_']['columns']]: NonNullable<T['_']['columns'][K]['_']['data']> extends Sealed<any, any> ? never :
    T['_']['columns'][K]['_']['columnType'] extends 'PgUUID' | 'PgText' | 'PgCustomColumn' ? K : never;
}[keyof T['_']['columns']] & string;
export type SealMeta<T extends PgTable, R extends string, S extends string | undefined> = {
  readonly [sealMetaBrand]?: { parent: T; row: R; scope: S };
};

function sealedColumn<T, O extends { nullable?: boolean; column?: string }, S>(name: string, options: O | undefined, spec: FieldSpec): NullableBuilder<T, S, O> {
  const dbName = options?.column ?? `${name}_ct`;
  const pending: PendingField = { name, spec: { ...spec, nullable: !!options?.nullable } };
  const guard = () => fail('SEAL_REQUIRED');
  pendingFields.set(guard, pending);
  const builder = customType<{ data: Sealed<T, S>; driverData: Uint8Array }>({
    dataType: () => 'bytea',
    toDriver(value) {
      ensure(value instanceof Sealed && writable.has(value) && value.binding === pending.bind, 'SEAL_REQUIRED');
      return value.bytes;
    },
    fromDriver(value) { return Sealed.fromDriver<T, S>(value, pending.bind); },
  })(dbName);
  return (options?.nullable ? builder.$defaultFn(guard) : builder.notNull().$defaultFn(guard)) as NullableBuilder<T, S, O>;
}

function createField<T, O extends { nullable?: boolean; column?: string }, S>(type: FieldSpec['type'], name: string, options?: O): NullableBuilder<T, S, O> {
  const { column: _column, nullable: _nullable, ...fieldOptions } = options ?? {};
  const spec = { type, ...fieldOptions, id: (fieldOptions as { id?: string }).id ?? name } as FieldSpec;
  validateField(spec);
  return sealedColumn<T, O, S>(name, options, spec);
}

function keyType(column: PgColumn): 'uuid' | 'text' {
  const kind = column.getSQLType();
  ensure(kind === 'uuid' || kind === 'text COLLATE "C"', 'INVALID_SCHEMA');
  return kind === 'uuid' ? 'uuid' : 'text';
}
function mirrorKey(name: string, type: 'uuid' | 'text') { return type === 'uuid' ? uuid(name) : textId(name); }
export const textId = customType<{ data: string; driverData: string }>({ dataType: () => 'text COLLATE "C"' });

function register<T extends PgTable, R extends UuidOrTextKeys<T>, S extends UuidOrTextKeys<T> | undefined = undefined>(
  table: T, cfg: { row: R; scope?: S; model?: string }, models: Set<string>,
): PgTable & SealMeta<T, R, S> {
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const rowColumn = columns[cfg.row];
  ensure(!!rowColumn && !rowColumn.keyAsName && rowColumn.notNull, 'INVALID_SCHEMA');
  const rowType = keyType(rowColumn);
  const scopeColumn = cfg.scope ? columns[cfg.scope] : undefined;
  ensure(!cfg.scope || (!!scopeColumn && !scopeColumn.keyAsName && scopeColumn.notNull && ['uuid', 'text', 'text COLLATE "C"'].includes(scopeColumn.getSQLType())), 'INVALID_SCHEMA');
  const scopeType = scopeColumn?.getSQLType() === 'uuid' ? 'uuid' : 'text';
  const tableConfig = getTableConfig(table);
  const hasUnique = [...tableConfig.primaryKeys, ...tableConfig.uniqueConstraints, ...tableConfig.indexes.filter(i => i.config.unique)]
    .some(key => {
      const keyColumns = 'columns' in key ? key.columns : key.config.columns;
      const names = keyColumns.map(c => 'name' in c ? c.name : undefined);
      return names.length === (cfg.scope ? 2 : 1) && names.includes(rowColumn.name) && (!scopeColumn || names.includes(scopeColumn.name));
    }) || (rowColumn.primary && !scopeColumn);
  // A row primary key is already enough to back a row-only FK even on scoped tables.
  const rowUnique = rowColumn.primary || [...tableConfig.primaryKeys, ...tableConfig.uniqueConstraints, ...tableConfig.indexes.filter(i => i.config.unique)]
    .some(key => {
      const keyColumns = 'columns' in key ? key.columns : key.config.columns;
      return keyColumns.length === 1 && 'name' in keyColumns[0] && keyColumns[0].name === rowColumn.name;
    });
  ensure(hasUnique || rowUnique, 'INVALID_SCHEMA');
  const model = cfg.model ?? getTableName(table);
  ensure(!models.has(model), 'INVALID_SCHEMA');
  const fields = new Map<string, FieldBinding>();
  const usedIds = new Set<string>();
  for (const [key, column] of Object.entries(columns)) {
    const guard = (column as PgColumn & { defaultFn?: Function }).defaultFn;
    const pending = guard ? pendingFields.get(guard) : undefined;
    if (!pending) continue;
    ensure(is(column, PgCustomColumn) && column.getSQLType() === 'bytea' && column.default === undefined && !column.primary && !column.isUnique && !column.generated && !column.generatedIdentity && !column.onUpdateFn, 'INVALID_SCHEMA');
    const fieldId = pending.spec.id ?? pending.name;
    ensure(!usedIds.has(fieldId), 'INVALID_SCHEMA');
    usedIds.add(fieldId);
    const binding = { key, column, spec: pending.spec, registration: undefined! };
    pending.bind = binding;
    fields.set(key, binding);
  }
  ensure(fields.size > 0, 'INVALID_SCHEMA');
  const definition: SealedModelDefinition = {
    id: model, identity: { scope: cfg.scope, row: cfg.row },
    fields: Object.fromEntries([...fields].map(([key, value]) => [key, value.spec])),
    columns, scopeType, rowType,
  };
  const profiles = companionProfiles(definition);
  const tableName = getTableName(table);
  const indexName = `${tableName}_seal_index`;
  const companionColumns: Record<string, any> = {
    scopeId: (scopeColumn ? mirrorKey('scope_id', scopeType) : textId('scope_id').default('_')).notNull(),
    rowId: mirrorKey('row_id', rowType).notNull(),
  };
  for (const profile of Object.values(profiles)) companionColumns[profile.tokens] = bigint(profile.tokens, { mode: 'bigint' }).array();
  const substring = Object.values(profiles).filter(profile => profile.mode === 'substring');
  const tableFactory: typeof pgTable = (tableConfig.schema ? pgSchema(tableConfig.schema).table : pgTable) as typeof pgTable;
  const companion = tableFactory(indexName, companionColumns, (t: any) => [
    // drizzle-kit 0.31 reads composite PK columns out of order on push; the same unique B-tree stays stable.
    uniqueIndex(`${indexName}_scope_row_uq`).on(t.scopeId, t.rowId),
    rowUnique
      ? foreignKey({ columns: [t.rowId], foreignColumns: [rowColumn] }).onDelete('cascade')
      : foreignKey({ columns: [t.scopeId, t.rowId], foreignColumns: [scopeColumn!, rowColumn] }).onDelete('cascade'),
    ...Object.entries(profiles).filter(([, profile]) => profile.mode === 'exact').map(([id, profile]) =>
      index(`${companionIndexName(indexName, id)}_bt`).on(sql.raw('scope_id'), sql.raw(`(${profile.tokens}[1])`), sql.raw('row_id'))),
    ...(substring.length ? [index(`${companionIndexName(indexName, 'substring')}_gin`).using('gin',
      t[substring[0].tokens], ...substring.slice(1).map(profile => t[profile.tokens]))] : []),
  ]);
  const storage: SealedStorage = { parent: { schema: tableConfig.schema ?? 'public', name: tableName }, index: {
    schema: tableConfig.schema ?? 'public', name: indexName, layout: 'companion-v1', profiles,
  } };
  const registration: Registration = { parent: table, index: companion, row: cfg.row, scope: cfg.scope, rowUnique, model, fields, definition, storage };
  for (const binding of fields.values()) binding.registration = registration;
  registrations.set(companion, registration);
  models.add(model);
  return companion as PgTable & SealMeta<T, R, S>;
}

export function registrationOf(seal: object): Registration {
  return registrations.get(seal) ?? fail('INVALID_SCHEMA');
}

export function createSealed(options: { sealer: Sealer | (() => Sealer) }) {
  let resolved: Sealer | undefined;
  const models = new Set<string>();
  const sealer = () => resolved ??= typeof options.sealer === 'function' ? options.sealer() : options.sealer;
  return {
    text: <const O extends TextOptions = {}>(name: string, opts?: O) => createField<string, O, SearchOf<O & { type: 'text' }>>('text', name, opts),
    integer: <const O extends IntegerOptions = {}>(name: string, opts?: O) => createField<number, O, SearchOf<O & { type: 'integer' }>>('integer', name, opts),
    bigint: <const O extends BigintOptions = {}>(name: string, opts?: O) => createField<bigint, O, SearchOf<O & { type: 'bigint' }>>('bigint', name, opts),
    decimal: <const O extends DecimalOptions>(name: string, opts: O) => createField<string, O, SearchOf<O & { type: 'decimal' }>>('decimal', name, opts),
    boolean: <const O extends BooleanOptions = {}>(name: string, opts?: O) => createField<boolean, O, false>('boolean', name, opts),
    instant: <const O extends InstantOptions = {}>(name: string, opts?: O) => createField<Date, O, false>('instant', name, opts),
    json: <const O extends JsonOptions = {}>(name: string, opts?: O) => createField<JsonValue, O, false>('json', name, opts),
    bytes: <const O extends BytesOptions = {}>(name: string, opts?: O) => createField<Uint8Array, O, false>('bytes', name, opts),
    textId,
    register: <T extends PgTable, R extends UuidOrTextKeys<T>, S extends UuidOrTextKeys<T> | undefined = undefined>(
      table: T, cfg: { row: R; scope?: S; model?: string },
    ) => register(table, cfg, models),
    extraMigrationSql(seal: object): string[] {
      const reg = registrationOf(seal);
      return Object.values(reg.storage.index?.profiles ?? {}).filter(profile => profile.mode === 'substring')
        .map(profile => `alter table "${reg.storage.index!.schema}"."${reg.storage.index!.name}" alter column "${profile.tokens}" set statistics 1000`);
    },
    ...runtimeMethods(sealer),
  };
}
