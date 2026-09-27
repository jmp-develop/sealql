import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { assertDisposable } from '../../test/disposable.js';
import { customers, customersSeal, sealed, scopeId, tickets, ticketsSeal } from './schema.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
const db=drizzle(pool);
const captured:{text:string;values:any[]}[]=[];
const rawPoolQuery=pool.query.bind(pool);
(pool as any).query=(...args:any[])=>{
  const q=args[0];if(typeof q==='object'&&q?.text&&!String(q.text).startsWith('explain'))captured.push({text:q.text,values:args[1]??q.values??[]});
  else if(typeof q==='string'&&q.startsWith('select'))captured.push({text:q,values:Array.isArray(args[1])?args[1]:[]});
  return (rawPoolQuery as any)(...args);
};
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);captured.length=0;
  const page=await sealed.search(db,{scope:scopeId,match:{t:[ticketsSeal,m=>m.memo.contains('서비스')],
    c:[customersSeal,m=>m.company.eq('서울서비스 담당')]},limit:20,
    query:({where,after,orderBy,flags,limit})=>db.select({t:tickets,c:customers,...flags}).from(tickets)
      .innerJoin(customers,eq(tickets.customerId,customers.id)).where(and(where,after)).orderBy(...orderBy).limit(limit)});
  assert.equal(page.items.length,20);assert.equal(captured.length,1);
  const query=captured[0];
  const explain=(await pool.query(`explain (analyze,buffers,format json) ${query.text}`,query.values)).rows[0]['QUERY PLAN'][0];
  await writeFile('bench/results/2026-09-27-native-verification/v3/join-explain.json',JSON.stringify({
    query:{text:query.text,parameterCount:query.values.length},plan:explain},null,2)+'\n');
  console.log(JSON.stringify({sql:query.text.slice(0,1000),executionMs:explain['Execution Time'],top:explain.Plan['Node Type']}));
}finally{await pool.end();}
