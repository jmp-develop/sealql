import { pgSchema, integer, text, index, customType } from 'drizzle-orm/pg-core';
import { sql, relations } from 'drizzle-orm';
export const poc = pgSchema('drizzle_poc');
export const sealedType = customType<{data:string;driverData:string}>({
  dataType: () => 'jsonb',
  toDriver: value => JSON.stringify({ ct: value, tokens: [...new Set(Array.from(value).map((_, i) => value.slice(i,i+2)).filter(x => x.length === 2))] }),
  fromDriver: value => (typeof value === 'string' ? JSON.parse(value) : value).ct,
});
export const items = poc.table('items', {
  id: integer('id').primaryKey(),
  publicText: text('public_text'),
  sealed: sealedType('sealed'),
}, table => [index('items_tokens_gin').using('gin', sql`(${table.sealed} -> 'tokens')`)]);
export const children = poc.table('children', { id: integer('id').primaryKey(), itemId: integer('item_id').references(() => items.id), note: sealedType('note') });
export const itemsRelations = relations(items, ({many}) => ({ children: many(children) }));
export const childrenRelations = relations(children, ({one}) => ({ item: one(items, {fields:[children.itemId], references:[items.id]}) }));
export const driverItems = poc.table('driver_items', {id:integer('id').primaryKey(),secret:text('secret')});
