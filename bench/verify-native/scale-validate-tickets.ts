/** Authenticate cloned rows and compare copied companion arrays with public token recomputation. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId } from './schema.js';
import { cloneId, scaleTicketsSeal, scaleSealed } from './scale-schema.js';
import { recompute } from './tokens.js';

const n=Number(process.argv[2]??'10000');assert(n===10||n===10000);
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  const ticketCopies=Number((await pool.query('select count(*) n from native_scale_100m.ticket_progress')).rows[0].n);
  assert(ticketCopies===100||ticketCopies===1000);
  const originals=(await pool.query('select id from bench_realistic_100k.tickets where scope_id=$1 order by id',[scopeId])).rows;
  assert.equal(originals.length,100000);
  let state=21027;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};
  const ids:string[]=[];
  if(n===10)for(let i=0;i<10;i++)ids.push(cloneId(originals[i].id,0));
  else for(let copy=0;copy<ticketCopies;copy++){
    const chosen=new Set<number>(),perCopy=n/ticketCopies;
    while(chosen.size<perCopy)chosen.add(Math.floor(random()*originals.length));
    for(const j of chosen)ids.push(cloneId(originals[j].id,copy));
  }
  assert.equal(ids.length,n);
  const parent=(await pool.query('select * from native_scale_100m.tickets where id=any($1::uuid[])',[ids])).rows;
  const plain=(await pool.query('select * from native_scale_100m.tickets_plain where id=any($1::uuid[])',[ids])).rows;
  const index=(await pool.query('select * from native_scale_100m.tickets_seal_index where scope_id=$2 and row_id=any($1::uuid[])',[ids,scopeId])).rows;
  assert.equal(parent.length,n);assert.equal(plain.length,n);assert.equal(index.length,n);
  const mapping={id:'id',scopeId:'scope_id',...Object.fromEntries(fields.map(f=>[f,`${f}_ct`]))};
  const opened=await scaleSealed.openRaw(scaleTicketsSeal,parent,{columns:mapping as any,scope:scopeId});
  const parentById=new Map(parent.map(r=>[r.id,r])),plainById=new Map(plain.map(r=>[r.id,r])),indexById=new Map(index.map(r=>[r.row_id,r]));
  let tokenColumns=0;
  for(const row of opened){
    const source=plainById.get(row.id);const stored=indexById.get(row.id);assert(source&&stored);
    const encrypted=parentById.get(row.id);assert(encrypted);
    assert.equal(encrypted.customer_id,source.customer_id,`${row.id}/customer_id`);
    for(const f of fields){
      const value=source[`${f}_plain`];assert.equal(row[`${f}_ct`],value,`${row.id}/${f}/cipher`);
      const expected=await recompute('tickets',f,scopeId,value);
      for(const [col,tokens] of Object.entries(expected)){
        assert.deepEqual((stored[col]??[]).map(String).sort(),tokens.map(String).sort(),`${row.id}/${f}/${col}`);
        tokenColumns++;
      }
    }
  }
  const report={rows:n,fields:fields.length,tokenColumns,missing:0,extra:0,cipherMismatches:0,scopeId,
    sampleSeed:n===10?null:21027,copiesCovered:n===10?1:ticketCopies};
  if(n===10000){
    const out='bench/results/2026-09-27-native-scale-100m';await mkdir(out,{recursive:true});
    await writeFile(`${out}/ticket-validation.json`,JSON.stringify({...report,ticketCopies},null,2)+'\n');
  }
  console.log(JSON.stringify(report));
}finally{await pool.end();}
