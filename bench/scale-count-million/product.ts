import {createSealer} from 'sealql';
import {createSealed} from 'sealql/drizzle/v0.45';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {fields,schema} from './common.js';
export const cipher=createSealer({key:new Uint8Array(32).fill(93)}),sealed=createSealed({sealer:cipher});
export const customers=pgSchema(schema).table('customers',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:true}})]))});
export const customersSeal=sealed.register(customers,{row:'id',scope:'scopeId'});
