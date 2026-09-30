import { is, type SQL } from 'drizzle-orm';
import {
  customType, getTableConfig, PgCustomColumn, PgDialect, PgTransaction,
  type PgColumn, type PgDatabase, type PgTable,
} from 'drizzle-orm/pg-core';

export type DrizzleDb = PgDatabase<any, any, any>;
export type DrizzleTransaction = PgTransaction<any, any, any>;
export type DrizzleColumns<T extends PgTable> = T['_']['columns'];
export type DrizzleColumnData<C> = C extends { _: { data: infer D } } ? D : never;
export type DrizzleColumnType<C> = C extends { _: { columnType: infer K } } ? K : never;
export type DrizzleCustomBuilder<T, D> = ReturnType<ReturnType<typeof customType<{ data: T; driverData: D }>>>;
export type DrizzleNullableBuilder<T, D, O> = O extends { nullable: true }
  ? DrizzleCustomBuilder<T, D> : ReturnType<DrizzleCustomBuilder<T, D>['notNull']>;

export const drizzleCustomType = customType;

export function customBuilder<T, D>(builder: unknown): DrizzleCustomBuilder<T, D> {
  return builder as DrizzleCustomBuilder<T, D>;
}

export function nullableCustomBuilder<T, D, O>(
  builder: DrizzleCustomBuilder<T, D>, nullable: boolean, guard: () => never,
): DrizzleNullableBuilder<T, D, O> {
  return (nullable ? builder.$defaultFn(guard) : builder.notNull().$defaultFn(guard)) as DrizzleNullableBuilder<T, D, O>;
}

export function columnInfo(column: PgColumn) {
  return {
    get name() { return column.name; },
    get table() { return column.table; },
    get sqlType() { return column.getSQLType(); },
    get keyAsName() { return column.keyAsName; },
    get notNull() { return column.notNull; },
    get primary() { return column.primary; },
    get isUnique() { return column.isUnique; },
    get defaultValue() { return column.default; },
    get defaultFn() { return (column as PgColumn & { defaultFn?: Function }).defaultFn; },
    get generated() { return column.generated; },
    get generatedIdentity() { return column.generatedIdentity; },
    get onUpdateFn() { return column.onUpdateFn; },
    get custom() { return is(column, PgCustomColumn); },
  };
}

export function drizzleTableConfig(table: PgTable) {
  return getTableConfig(table);
}

export function isTransaction(value: unknown): boolean {
  return is(value, PgTransaction);
}

export function drizzleQuery(value: SQL) {
  return new PgDialect().sqlToQuery(value);
}
