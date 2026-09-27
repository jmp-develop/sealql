import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
const gate = pgSchema('gate_x1x2_kit');
export const plain = gate.table('plain', { id: uuid('id').primaryKey(), status: text('status') });
