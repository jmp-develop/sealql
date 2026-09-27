/** Authenticate cloned rows and compare copied companion arrays with public token recomputation. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId as scopeA } from './schema.js';
import { cloneId, scaleCustomersSeal, scaleSealed } from './scale-schema.js';
import { recompute } from './tokens.js';
const scopeB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const copy=999;

const n=1000;
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=0'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const originals=(await pool.query('select id from bench_realistic_100k.customers where scope_id=$1 order by id',[scopeA])).rows;
  assert.equal(originals.length,100000);
  let state=21027;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};
  const chosen=new Set<number>();while(chosen.size<n)chosen.add(Math.floor(random()*originals.length));
  const ids=[...chosen].map(j=>cloneId(originals[j].id,copy));
  assert.equal(ids.length,n);
  const parent=(await pool.query('select * from native_scale_100m.customers where id=any($1::uuid[])',[ids])).rows;
  const plain=(await pool.query('select * from native_scale_100m.customers_plain where id=any($1::uuid[])',[ids])).rows;
  const index=(await pool.query('select * from native_scale_100m.customers_seal_index where scope_id=$2 and row_id=any($1::uuid[])',[ids,scopeB])).rows;
  assert.equal(parent.length,n);assert.equal(plain.length,n);assert.equal(index.length,n);
  for(const row of [...parent,...plain,...index])assert.equal(row.scope_id,scopeB);
  const mapping={id:'id',scopeId:'scope_id',...Object.fromEntries(fields.map(f=>[f,`${f}_ct`]))};
  const opened:any[]=[];
  for(let i=0;i<parent.length;i+=100)
    opened.push(...await scaleSealed.openRaw(scaleCustomersSeal,parent.slice(i,i+100),
      {columns:mapping as any,scope:scopeB}));
  const plainById=new Map(plain.map(r=>[r.id,r])),indexById=new Map(index.map(r=>[r.row_id,r]));
  let tokenColumns=0;
  for(const row of opened){
    const source=plainById.get(row.id);const stored=indexById.get(row.id);assert(source&&stored);
    for(const f of fields){
      const value=source[`${f}_plain`];assert.equal(row[`${f}_ct`],value,`${row.id}/${f}/cipher`);
      const expected=await recompute('customers',f,scopeB,value);
      for(const [col,tokens] of Object.entries(expected)){
        assert.deepEqual((stored[col]??[]).map(String).sort(),tokens.map(String).sort(),`${row.id}/${f}/${col}`);
        tokenColumns++;
      }
    }
  }
  const totals:any={};
  for(const table of ['customers','customers_seal_index','customers_plain']){
    const counts=(await pool.query(`select scope_id,count(*) n from native_scale_100m.${table} group by scope_id`)).rows;
    const byScope=Object.fromEntries(counts.map(r=>[r.scope_id,Number(r.n)]));
    assert.equal(byScope[scopeB],100000,`${table}/B`);
    assert.equal(byScope[scopeA],99900000,`${table}/A`);
    assert.equal(Object.values(byScope).reduce((a:number,b:any)=>a+Number(b),0),100000000,`${table}/total`);
    totals[table]=byScope;
  }
  const report={rows:n,fields:fields.length,tokenColumns,missing:0,extra:0,cipherMismatches:0,scopeB,
    sampleSeed:21027,copy,totals};
  const out='bench/results/2026-09-27-native-scale-100m/scope-b';await mkdir(out,{recursive:true});
  await writeFile(`${out}/validation.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{await pool.end();}
