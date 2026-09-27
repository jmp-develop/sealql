import { ensure } from '../../core/errors.js';
import { utf8 } from '../../core/bytes.js';
import { validateField, type FieldSpec } from '../../core/field-codec.js';
import { companionIndexName, companionProfiles } from '../../core/companion-layout.js';
import { column as ident, join, literal, pgsql as q, render, type Statement } from './fragment.js';
import type { SealedModelDefinition, SealedStorage } from '../../engine/sealed-types.js';

export type PublicType = 'text' | 'boolean' | 'integer' | 'bigint' | 'uuid' | 'instant';
export interface PublicSpec { type: PublicType; nullable: boolean; maxBytes?: number; hasDefault?: boolean; generated?: boolean }
export type NativeFieldSpec = FieldSpec & { nullable: boolean };
export interface NativeModel<F extends Record<string, NativeFieldSpec> = Record<string, NativeFieldSpec>> {
  id: string; identity: { scope: 'uuid' | 'text'; row: 'uuid' | 'text'; revision: 'bigint' };
  fields: F; public: Record<string, PublicSpec>; orderable: readonly string[];
}
const identifier = (name: string) => ensure(typeof name === 'string' && utf8(name).length >= 1 && utf8(name).length <= 63 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'INVALID_SCHEMA');
const typeSql = (type: PublicType): string => ({ text: 'text', boolean: 'boolean', integer: 'integer', bigint: 'bigint', uuid: 'uuid', instant: 'timestamp with time zone' })[type];
const keySql = (type: 'uuid' | 'text') => type === 'uuid' ? 'uuid' : 'text COLLATE "C"';

export function defineSealedModel<const F extends Record<string, NativeFieldSpec>>(options: {
  id: string; identity: NativeModel['identity']; fields: F; public?: Record<string, PublicSpec>; orderable?: readonly string[];
}): NativeModel<F> {
  ensure(typeof options.id === 'string' && utf8(options.id).length > 0 && utf8(options.id).length <= 128, 'INVALID_SCHEMA');
  ensure(['uuid', 'text'].includes(options.identity.scope) && ['uuid', 'text'].includes(options.identity.row) && options.identity.revision === 'bigint', 'INVALID_SCHEMA');
  const fieldIds = new Set<string>();
  for (const [key, spec] of Object.entries(options.fields)) {
    identifier(key); validateField(spec);
    ensure(typeof spec.nullable === 'boolean' && !fieldIds.has(spec.id ?? key), 'INVALID_SCHEMA');
    fieldIds.add(spec.id ?? key);
  }
  ensure(Object.keys(options.fields).every(key => !['scope', 'row', 'revision'].includes(key)), 'INVALID_SCHEMA');
  for (const [key, spec] of Object.entries(options.public ?? {})) {
    identifier(key);
    ensure(!Object.hasOwn(options.fields, key) && !['scope', 'row', 'revision'].includes(key) && ['text', 'boolean', 'integer', 'bigint', 'uuid', 'instant'].includes(spec.type) && typeof spec.nullable === 'boolean', 'INVALID_SCHEMA');
    if (spec.type === 'text') ensure(Number.isInteger(spec.maxBytes) && (spec.maxBytes ?? 0) > 0 && (spec.maxBytes ?? 0) <= 1048576, 'INVALID_SCHEMA');
  }
  for (const key of options.orderable ?? []) ensure(Object.hasOwn(options.public ?? {}, key) && !(options.public ?? {})[key].nullable && ['integer', 'bigint', 'uuid', 'instant'].includes((options.public ?? {})[key].type), 'INVALID_SCHEMA');
  return Object.freeze({ id: options.id, identity: Object.freeze({ ...options.identity }), fields: Object.freeze({ ...options.fields }), public: Object.freeze({ ...options.public }), orderable: Object.freeze([...(options.orderable ?? [])]) });
}
export function definePostgresStorage<F extends Record<string, NativeFieldSpec>>(model: NativeModel<F>, mapping: {
  schema?: string; table: string; identity: { scope: string; row: string; revision: string };
  fields: Record<keyof F & string, string>; public?: Record<string, string>; indexTable?: string;
}): { definition: SealedModelDefinition & { fields: F }; storage: SealedStorage; ddl: Statement[] } {
  const schema = mapping.schema ?? 'public';
  for (const name of [schema, mapping.table, ...Object.values(mapping.identity), ...Object.values(mapping.fields), ...Object.values(mapping.public ?? {})]) identifier(name);
  const indexName = mapping.indexTable ?? `${mapping.table}_seal_index`;
  const searchable = Object.values(model.fields).some(spec => !!spec.search);
  if (searchable) identifier(indexName); else ensure(mapping.indexTable === undefined, 'INVALID_SCHEMA');
  ensure(Object.keys(mapping.fields).length === Object.keys(model.fields).length && Object.keys(mapping.public ?? {}).length === Object.keys(model.public).length, 'INVALID_SCHEMA');
  const names = [...Object.values(mapping.identity), ...Object.values(mapping.fields), ...Object.values(mapping.public ?? {})];
  ensure(new Set(names).size === names.length && mapping.table !== indexName, 'INVALID_SCHEMA');
  const columns: SealedModelDefinition['columns'] = {};
  for (const [key, name] of Object.entries(mapping.identity)) columns[key] = { name, getSQLType: () => key === 'revision' ? 'bigint' : keySql(model.identity[key as 'scope' | 'row']), notNull: true, hasDefault: key === 'revision' };
  for (const [key, spec] of Object.entries(model.fields)) columns[key] = { name: mapping.fields[key], getSQLType: () => 'bytea', notNull: !spec.nullable, hasDefault: false };
  for (const [key, spec] of Object.entries(model.public)) {
    const name = mapping.public?.[key]; ensure(name, 'INVALID_SCHEMA');
    columns[key] = { name, getSQLType: () => typeSql(spec.type), notNull: !spec.nullable, hasDefault: !!spec.hasDefault, generated: spec.generated };
  }
  const definition: SealedModelDefinition & { fields: F } = {
    id: model.id, identity: { scope: 'scope', row: 'row', revision: 'revision' }, fields: model.fields, columns,
    scopeType: model.identity.scope, rowType: model.identity.row, orderable: model.orderable,
    publicBounds: Object.fromEntries(Object.entries(model.public).filter(([, spec]) => spec.maxBytes).map(([key, spec]) => [key, spec.maxBytes!])),
  };
  const profileMap = searchable ? companionProfiles(definition) : undefined;
  const storage: SealedStorage = { parent: { schema, name: mapping.table }, index: profileMap ? { schema, name: indexName, layout: 'companion-v1', profiles: profileMap } : undefined };
  const parent = ident(schema, mapping.table), col = (name: string) => ident(name);
  const parentCols = [
    q`${col(mapping.identity.scope)} ${literal(keySql(model.identity.scope))} not null`,
    q`${col(mapping.identity.row)} ${literal(keySql(model.identity.row))} not null`,
    q`${col(mapping.identity.revision)} bigint not null default 1 check (${col(mapping.identity.revision)}>0)`,
    ...Object.entries(model.fields).map(([key, spec]) => q`${col(mapping.fields[key])} bytea${literal(spec.nullable ? '' : ' not null')}`),
    ...Object.entries(model.public).map(([key, spec]) => q`${col(mapping.public![key])} ${literal(typeSql(spec.type))}${literal(spec.nullable ? '' : ' not null')}`),
    q`unique (${col(mapping.identity.scope)},${col(mapping.identity.row)})`,
  ];
  const ddl = [render(q`create table ${parent} (${join(parentCols, ',')})`)];
  if (profileMap) {
    const index = ident(schema, indexName);
    const profileColumns = Object.values(profileMap).map(profile => q`${col(profile.tokens)} bigint[]`);
    ddl.push(render(q`create table ${index} (scope_id ${literal(keySql(model.identity.scope))} not null,row_id ${literal(keySql(model.identity.row))} not null,${join(profileColumns, ',')},primary key(scope_id,row_id),foreign key(scope_id,row_id) references ${parent}(${col(mapping.identity.scope)},${col(mapping.identity.row)}) on delete cascade)`));
    for (const [indexId, profile] of Object.entries(profileMap)) {
      const name = companionIndexName(indexName, indexId);
      if (profile.mode === 'exact') ddl.push(render(q`create index ${ident(`${name}_bt`)} on ${index}(scope_id,(${col(profile.tokens)}[1]),row_id)`));
      if (profile.mode === 'substring') ddl.push(render(q`alter table ${index} alter column ${col(profile.tokens)} set statistics 1000`));
    }
    const substringColumns = Object.values(profileMap).filter(profile => profile.mode === 'substring').map(profile => col(profile.tokens));
    if (substringColumns.length) ddl.push(render(q`create index ${ident(`${companionIndexName(indexName, 'substring')}_gin`)} on ${index} using gin(${join(substringColumns, ',')})`));
  }
  return { definition, storage, ddl };
}
