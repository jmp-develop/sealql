import { getTableColumns, is, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { bigint, customType, foreignKey, getTableConfig, index, jsonb, PgCustomColumn, pgSchema, pgTable, primaryKey, text, uuid, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { ensure } from '../../core/errors.js';
import { unhex, utf8 } from '../../core/bytes.js';
import { envelopeShape, type Ciphertext } from '../../core/field-cipher.js';
import { validateField, type FieldSpec, type PlainOf, type SearchProtection } from '../../core/field-codec.js';
import { companionIndexName, companionProfiles } from '../../core/companion-layout.js';

const bytea = customType<{ data: Ciphertext; driverData: Uint8Array | string }>({
  dataType: () => 'bytea',
  toDriver(value) { envelopeShape(value); return value.slice(); },
  fromDriver(value) { return (typeof value === 'string' ? unhex(value.startsWith('\\x') ? value.slice(2) : value) : new Uint8Array(value)) as Ciphertext; },
});
const digest = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });
export const sealTextId = customType<{ data: string; driverData: string }>({ dataType: () => 'text COLLATE "C"' });
/** Native bytea builder. Encryption runs only through the managed repository. */
export const ciphertext = (name: string) => bytea(name);
type Columns<T extends PgTable> = T['_']['columns'];
type CipherKeys<T extends PgTable> = { [K in keyof Columns<T>]: NonNullable<Columns<T>[K]['_']['data']> extends Ciphertext ? K : never }[keyof Columns<T>] & string;
type IdentityKeys<T extends PgTable> = keyof Columns<T> & string;
type Specs<T extends PgTable> = Partial<Record<CipherKeys<T>, FieldSpec>>;
export interface SealedDefinition<T extends PgTable = PgTable, F extends Record<string, FieldSpec> = Record<string, FieldSpec>, I extends { scope: string; row: string; revision: string } = { scope: string; row: string; revision: string }> {
  readonly table: T; readonly id: string; readonly identity: I; readonly searchProtection: SearchProtection;
  readonly fields: F; readonly columns: Readonly<Record<string, PgColumn>>; readonly orderable: readonly string[];
  readonly publicBounds: Readonly<Record<string, number>>;
  readonly scopeType: 'uuid' | 'text'; readonly rowType: 'uuid' | 'text';
}
type PublicInsert<T extends PgTable, F extends Record<string, FieldSpec>, I extends { scope: string; row: string; revision: string }> = {
  [K in keyof InferInsertModel<T> as K extends keyof F | I['scope' | 'row' | 'revision'] ? never : K]: InferInsertModel<T>[K]
};
export type ManagedRow<D extends SealedDefinition> = D extends SealedDefinition<infer T, infer F, infer I> ?
  Omit<InferSelectModel<T>, keyof F | I['scope' | 'row' | 'revision']> & { id: string; revision: bigint } & { [K in keyof F]: K extends keyof InferSelectModel<T> ? null extends InferSelectModel<T>[K] ? PlainOf<F[K]> | null : PlainOf<F[K]> : never } : never;
export type ManagedInsert<D extends SealedDefinition> = D extends SealedDefinition<infer T, infer F, infer I> ?
  PublicInsert<T, F, I> &
  { [K in keyof F as K extends keyof InferSelectModel<T> ? null extends InferSelectModel<T>[K] ? never : K : never]-?: PlainOf<F[K]> } &
  { [K in keyof F as K extends keyof InferSelectModel<T> ? null extends InferSelectModel<T>[K] ? K : never : never]?: PlainOf<F[K]> | null } : never;
const identifier = (name: string) => ensure(typeof name === 'string' && utf8(name).length >= 1 && utf8(name).length <= 63 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name), 'INVALID_SCHEMA');
function keyType(column: PgColumn): 'uuid' | 'text' { const type = column.getSQLType(); ensure(type === 'uuid' || type === 'text COLLATE "C"', 'INVALID_SCHEMA'); return type === 'uuid' ? 'uuid' : 'text'; }
export function defineSealed<const T extends PgTable, const I extends { scope: IdentityKeys<T>; row: IdentityKeys<T>; revision: IdentityKeys<T> }, const F extends Record<string, FieldSpec>>(table: T, options: {
  id: string; identity: I;
  fields: F & (Exclude<CipherKeys<T>, keyof F> extends never ? unknown : { __missingCiphertextFields: Exclude<CipherKeys<T>, keyof F> }) & (Exclude<keyof F, CipherKeys<T>> extends never ? unknown : { __invalidPlaintextFields: Exclude<keyof F, CipherKeys<T>> });
  orderable?: readonly (keyof T['_']['columns'] & string)[]; publicBounds?: Partial<Record<keyof T['_']['columns'] & string, number>>;
  searchProtection?: SearchProtection;
}): SealedDefinition<T, F, I> {
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  ensure(typeof options.id === 'string' && utf8(options.id).length >= 1 && utf8(options.id).length <= 128, 'INVALID_SCHEMA');
  ensure(options.searchProtection === undefined || options.searchProtection === 'standard', 'INVALID_SCHEMA');
  const identity = options.identity;
  ensure(new Set(Object.values(identity)).size === 3 && Object.values(identity).every(k => Object.hasOwn(cols, k)), 'INVALID_SCHEMA');
  const scopeType = keyType(cols[identity.scope]), rowType = keyType(cols[identity.row]);
  ensure(cols[identity.scope].notNull && cols[identity.row].notNull && cols[identity.revision].notNull && cols[identity.revision].getSQLType() === 'bigint', 'INVALID_SCHEMA');
  const config = getTableConfig(table);
  const scopedUnique = [...config.primaryKeys, ...config.uniqueConstraints].some(key => {
    const keyCols = key.columns.map(c => c.name);
    return keyCols.length === 2 && keyCols.includes(cols[identity.scope].name) && keyCols.includes(cols[identity.row].name);
  });
  ensure(scopedUnique, 'INVALID_SCHEMA');
  const all = new Set(Object.keys(options.fields));
  for (const key of all) {
    const col = cols[key];
    ensure(col && is(col, PgCustomColumn) && col.getSQLType() === 'bytea' && col.table === table && !Object.values(identity).includes(key), 'INVALID_SCHEMA');
    ensure(!col.default && !col.defaultFn && !col.onUpdateFn && !col.generated && !col.generatedIdentity && !col.primary && !col.isUnique && !col.hasDefault, 'INVALID_SCHEMA');
  }
  const ids = new Set<string>();
  for (const [key, spec] of Object.entries(options.fields as Record<string, FieldSpec>)) { validateField(spec); const id = spec.id ?? key; ensure(!ids.has(id), 'INVALID_SCHEMA'); ids.add(id); }
  for (const key of options.orderable ?? []) ensure(Object.hasOwn(cols, key) && !all.has(key) && cols[key].notNull && !cols[key].onUpdateFn && ['uuid', 'integer', 'bigint', 'timestamp with time zone'].includes(cols[key].getSQLType()), 'INVALID_SCHEMA');
  for (const [key, bound] of Object.entries(options.publicBounds ?? {})) ensure(Object.hasOwn(cols, key) && !all.has(key) && typeof bound === 'number' && Number.isInteger(bound) && bound > 0 && bound <= 1048576, 'INVALID_SCHEMA');
  return Object.freeze({ table, id: options.id, searchProtection: options.searchProtection ?? 'standard', identity: Object.freeze({ ...identity }), fields: Object.freeze({ ...options.fields }), columns: Object.freeze({ ...cols }), orderable: Object.freeze([...(options.orderable ?? [])]), publicBounds: Object.freeze({ ...options.publicBounds }), scopeType, rowType }) as SealedDefinition<T, F, I>;
}

export function defineSealStorage<D extends SealedDefinition>(definition: D, options: { schema?: string; indexTable?: string } = {}) {
  const schema = options.schema ?? 'public'; identifier(schema);
  const searchable = Object.values(definition.fields).some(field => !!field.search);
  ensure(searchable || !options.indexTable, 'INVALID_SCHEMA');
  const tableName = getTableConfig(definition.table).name;
  const indexName = options.indexTable ?? `${tableName}_seal_index`;
  identifier(indexName);
  ensure(tableName !== indexName, 'INVALID_SCHEMA');
  const tbl: typeof pgTable = (schema === 'public' ? pgTable : pgSchema(schema).table) as typeof pgTable;
  const scopeColumn = () => definition.scopeType === 'uuid' ? uuid('scope_id') : sealTextId('scope_id');
  const rowColumn = () => definition.rowType === 'uuid' ? uuid('row_id') : sealTextId('row_id');
  const profiles = searchable ? companionProfiles(definition) : undefined;
  const substringProfiles = Object.values(profiles ?? {}).filter(profile => profile.mode === 'substring');
  const parentCols = definition.columns;
  const companion = profiles ? tbl(indexName, {
    scopeId: scopeColumn().notNull(), rowId: rowColumn().notNull(),
    ...Object.fromEntries(Object.values(profiles).map(profile => [profile.tokens, bigint(profile.tokens, { mode: 'bigint' }).array()])),
  } as any, (t: any) => [
    primaryKey({ columns: [t.scopeId, t.rowId] }),
    foreignKey({ columns: [t.scopeId, t.rowId], foreignColumns: [parentCols[definition.identity.scope], parentCols[definition.identity.row]] }).onDelete('cascade'),
    ...Object.entries(profiles).filter(([, profile]) => profile.mode === 'exact').map(([indexId, profile]) =>
      index(`${companionIndexName(indexName, indexId)}_bt`).on(t.scopeId, sql`(${t[profile.tokens]})[1]`, t.rowId)),
    ...(substringProfiles.length
      ? [index(`${companionIndexName(indexName, 'substring')}_gin`).using('gin',
        t[substringProfiles[0].tokens], ...substringProfiles.slice(1).map(profile => t[profile.tokens]))]
      : []),
  ]) : undefined;
  return Object.freeze({ index: companion, profiles });
}

