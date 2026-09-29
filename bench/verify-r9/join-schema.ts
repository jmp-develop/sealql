import {pgSchema,uuid,index} from 'drizzle-orm/pg-core';
import {sealed} from './common.js';
export const joinSchema='test_r9_verify_join';
export const tickets=pgSchema(joinSchema).table('tickets',{
 id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),customerId:uuid('customer_id').notNull(),
 memo:sealed.text('memo',{search:{exact:true,substring:{wordBoundary:true}}}),
},t=>[index('tickets_customer_idx').on(t.scopeId,t.customerId,t.id)]);
export const ticketsSeal=sealed.register(tickets,{row:'id',scope:'scopeId'});
