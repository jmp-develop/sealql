import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
export const gate = pgSchema('gate_x1x2_kit');
export const plain = gate.table('plain', { id: uuid('id').primaryKey(), status: text('status') });
export const sealed = gate.table('sealed', { id: uuid('id').primaryKey(), memoCt: text('memo_ct') });
