import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { assertDisposable } from '../../test/disposable.js';
import { customersSeal, sealed, scopeId } from './schema.js';

const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
const db=drizzle(pool),rawQuery=pool.query.bind(pool);
const captured:{text:string;values:any[]}[]=[];
(pool as any).query=(...args:any[])=>{
  const q=args[0];if(typeof q==='object'&&q?.text&&!String(q.text).startsWith('explain'))captured.push({text:q.text,values:args[1]??q.values??[]});
  return (rawQuery as any)(...args);
};
const cases=[
  {name:'sub_name_suffix',match:(m:any)=>m.name.contains('pshxt')},
  {name:'or3',match:(m:any)=>m.or(m.phone.eq('42-5748-1542'),m.phone.eq('21-7100-5875'),m.name.contains('pshxt'))},
  {name:'and6',match:(m:any)=>m.and(m.name.contains('민서'),m.phone.contains('-5'),m.address.contains('서울'),
    m.memo.contains('서비스'),m.email.contains('test'),m.company.eq('서울서비스 담당'))},
];
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const out=[];
  for(const c of cases){
    captured.length=0;const page=await sealed.findMany(db,customersSeal,{scope:scopeId,match:c.match,limit:20});
    assert.equal(captured.length,1);const query=captured[0];
    const explain=(await pool.query(`explain (analyze,buffers,format json) ${query.text}`,query.values)).rows[0]['QUERY PLAN'][0];
    out.push({case:c.name,returned:page.items.length,query:{text:query.text,parameterCount:query.values.length},plan:explain});
    console.log(JSON.stringify({case:c.name,executionMs:explain['Execution Time']}));
  }
  await writeFile('bench/results/2026-09-27-native-verification/v3/matrix-explain.json',JSON.stringify(out,null,2)+'\n');
}finally{await pool.end();}
