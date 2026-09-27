import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { and, eq, relations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { normalizeText } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { customers, customersSeal, fields, sealed, scopeId, tickets } from './schema.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
const db=drizzle(pool),out='bench/results/2026-09-27-native-verification/v1';
const customersRelations=relations(customers,({many})=>({tickets:many(tickets)}));
const ticketsRelations=relations(tickets,({one})=>({customer:one(customers,{fields:[tickets.customerId],references:[customers.id]})}));
const relational=drizzle(pool,{schema:{customers,tickets,customersRelations,ticketsRelations}});
const same=(a:any[],b:any[],label:string)=>{assert.equal(a.length,b.length,`${label}/count`);for(let i=0;i<a.length;i++)assert.deepEqual(a[i],b[i],`${label}/${i}`);};
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  for(const table of ['customers','tickets'])assert.equal(Number((await pool.query(`select count(*) n from native_verify_main.${table}`)).rows[0].n),100000);
  const report:any={checks:[]};
  const term='서울서비스 담당',id=(await pool.query('select id from bench_realistic_100k.customers order by id limit 1')).rows[0].id;
  const plainOr=(await pool.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers
    where scope_id=$1 and (company_norm=$2 or id=$3) order by id limit 20`,[scopeId,normalizeText(term,'legacy-text-v1'),id])).rows;
  const productOr=(await sealed.findMany(db,customersSeal,{scope:scopeId,match:m=>m.or(m.company.eq(term),m.sql(eq(customers.id,id))),
    columns:Object.fromEntries(fields.map(f=>[f,true])) as any,limit:20})).items;
  same(productOr.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,(r as any)[f]]))})),plainOr,'m.sql OR');
  report.checks.push({name:'m.sql OR',rows:plainOr.length,verdict:'통과'});
  const plainJoin=(await pool.query(`select c.id c_id,t.id t_id,${fields.map(f=>`c.${f}_plain c_${f},t.${f}_plain t_${f}`).join(',')}
    from bench_realistic_100k.customers c join bench_realistic_100k.tickets t on t.customer_id=c.id and t.scope_id=c.scope_id
    where c.scope_id=$1 and c.company_norm=$2 order by c.id,t.id limit 50`,[scopeId,normalizeText(term,'legacy-text-v1')])).rows;
  const productJoin:any[]=[];let cursor:string|undefined;
  for(let i=0;i<4&&productJoin.length<50;i++){
    const page=await sealed.search(db,{scope:scopeId,match:{c:[customersSeal,m=>m.company.eq(term)]},keyset:[tickets.id],limit:20,cursor,
      query:({where,after,orderBy,flags,limit})=>db.select({c:customers,t:tickets,...flags}).from(customers)
        .innerJoin(tickets,eq(tickets.customerId,customers.id)).where(and(where,after)).orderBy(...orderBy).limit(limit)});
    productJoin.push(...page.items);cursor=page.nextCursor??undefined;if(!cursor)break;
  }
  const flattened=productJoin.slice(0,50).map(r=>({c_id:r.c.id,t_id:r.t.id,...Object.fromEntries(fields.flatMap(f=>[[`c_${f}`,r.c[f]],[`t_${f}`,r.t[f]]]))}));
  same(flattened,plainJoin,'1:N JOIN search');report.checks.push({name:'1:N JOIN search',rows:plainJoin.length,verdict:'통과'});
  const ticket=(await pool.query('select customer_id from bench_realistic_100k.tickets order by id limit 1')).rows[0];
  const nested=await relational.query.customers.findMany({where:eq(customers.id,ticket.customer_id),with:{tickets:true}});
  const opened=await sealed.open(nested);
  assert.equal(opened.length,1);assert(opened[0].tickets.length>0);
  const source=(await pool.query('select name_plain,memo_plain from bench_realistic_100k.customers where id=$1',[ticket.customer_id])).rows[0];
  assert.equal(opened[0].name,source.name_plain);assert.equal(opened[0].memo,source.memo_plain);
  const ticketIds=(await pool.query('select id from bench_realistic_100k.tickets where customer_id=$1 order by id',[ticket.customer_id])).rows.map(x=>x.id);
  assert.deepEqual(opened[0].tickets.map(x=>x.id).sort(),ticketIds);
  report.checks.push({name:'relational open',tickets:ticketIds.length,verdict:'통과'});
  await writeFile(`${out}/extra.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await pool.end();}
