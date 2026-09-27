import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { createSealer } from 'sealql';
import { createSealed } from 'sealql/drizzle/v0.45';

export const scaleSchema=pgSchema('native_scale_100m');
export const scaleSealed=createSealed({sealer:()=>createSealer({key:new Uint8Array(32).fill(93)})});
const search={exact:true,substring:{wordBoundary:true,skipGrams:true}} as const;
export const scaleCustomers=scaleSchema.table('customers',{
  id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),
  name:scaleSealed.text('name',{search}),phone:scaleSealed.text('phone',{search}),
  address:scaleSealed.text('address',{search}),memo:scaleSealed.text('memo',{search}),
  email:scaleSealed.text('email',{search}),company:scaleSealed.text('company',{search}),
});
export const scaleCustomersSeal=scaleSealed.register(scaleCustomers,{row:'id',scope:'scopeId'});

export function cloneId(original:string,copy:number){
  if(!Number.isInteger(copy)||copy<0||copy>=1000)throw Error('copy must be 0..999');
  return (0x20000000+copy).toString(16).padStart(8,'0')+original.slice(8);
}
