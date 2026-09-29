import {and,eq} from 'drizzle-orm';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from 'sealql';
import {createSealed} from 'sealql/drizzle/v0.45';

export function driverSchema(schema: string) {
  const sealed=createSealed({sealer:createSealer({key:new Uint8Array(32).fill(79)})});
  const rows=pgSchema(schema).table('rows',{
    id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),
    body:sealed.text('body',{search:{exact:{bits:2},substring:{wordBoundary:true}}}),
  });
  return {sealed,rows,seal:sealed.register(rows,{row:'id',scope:'scopeId'})};
}
export interface DriverFixture { id:string;scope_id:string;memo_plain:string }
export async function driverFlow(db:any,schema:string,fixture:DriverFixture) {
  const {sealed,rows,seal}=driverSchema(schema),scope=fixture.scope_id;
  const original=fixture.memo_plain,updated=original+original;
  await sealed.insert(db,seal,{id:fixture.id,scopeId:scope,body:original});
  const found=await sealed.findMany(db,seal,{scope,match:m=>m.body.eq(original)});
  const count=await sealed.count(db,seal,{scope,match:m=>m.body.eq(original)});
  await sealed.update(db,seal,{id:fixture.id,scopeId:scope},{body:updated});
  const changed=await sealed.findMany(db,seal,{scope,match:m=>m.body.eq(updated)});
  const reindexed=await sealed.reindex(db,seal,{scope,batch:1});
  const joined=await sealed.search(db,{scope,match:{r:[seal,m=>m.body.eq(updated)]},
    query:({where,after,orderBy,flags})=>db.select({r:rows,...flags}).from(rows).where(and(where,after)).orderBy(...orderBy)});
  const prefix=Array.from(updated.replace(/\s/g,'')).slice(0,2).join('');
  const substring=await sealed.count(db,seal,{scope,match:m=>m.body.contains(prefix)});
  await db.delete(rows).where(eq(rows.id,fixture.id));
  const afterDelete=await sealed.count(db,seal,{scope,match:m=>m.body.eq(updated)});
  const ok=count===1&&found.items[0]?.body===original&&changed.items[0]?.body===updated&&reindexed.rows===1&&
    (joined.items[0] as {r:{body:string}}|undefined)?.r.body===updated&&substring===1&&afterDelete===0;
  return {ok,insert:found.items.length,count,update:changed.items.length,reindex:reindexed.rows,search:joined.items.length,substring,afterDelete};
}
