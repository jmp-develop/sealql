import assert from 'node:assert/strict';
import {S,pool,lock,unlock,save} from './b-runtime.js';
import {B_SCOPE} from './b-codec.js';
import {bFields,createTags,insertTags,indexTags} from './b-storage.js';
import {sourceTokenColumn} from './b-product.js';
const report:any={started:new Date().toISOString(),schema:S,source:'shared normalized plaintext + actual native_verify_main product tokens',fields:{customers:bFields('customers'),tickets:bFields('tickets')},tables:{}};
report.scopeChange='Coordinator 14:01Z: customers only; tickets and unified JOIN not measured, release lock by 14:30Z';
try{await lock();for(const table of ['customers'] as const){
  const exists=(await pool.query('SELECT to_regclass($1) name',[`${S}.b_${table}_tags`])).rows[0].name;
  if(!exists)await createTags(pool,S,table);
  const before=(await pool.query(`SELECT count(*)::int n,max(id::text) last FROM ${S}.b_${table}_tags`)).rows[0];
  assert.equal(Number((await pool.query(`SELECT count(*)::int n FROM ${S}.${table}_plain WHERE scope_id=$1`,[B_SCOPE])).rows[0].n),100000,'shared fixture must be ready');
  let loaded=before.n,last:string|undefined=before.last??undefined;const started=performance.now();
  report.tables[table]={rows:loaded,resumedFrom:before.n,loadMs:0};
  while(loaded<100000){const params:unknown[]=[B_SCOPE];if(last)params.push(last);
    const cols=bFields(table).flatMap(f=>[`${f}_norm`,`i."${sourceTokenColumn(table,f,true)}" ce_${f}`,`i."${sourceTokenColumn(table,f,false)}" cs_${f}`]);
    const rows=(await pool.query(`SELECT p.id,p.scope_id,${cols.join(',')} FROM ${S}.${table}_plain p JOIN native_verify_main.${table}_seal_index i ON i.row_id=p.id AND i.scope_id=p.scope_id WHERE p.scope_id=$1${last?' AND p.id>$2::uuid':''} ORDER BY p.id LIMIT 500`,params)).rows;
    assert(rows.length>0,'missing source product tokens');
    await insertTags(pool,S,table,rows);loaded+=rows.length;last=rows.at(-1)!.id;
    report.tables[table]={rows:loaded,resumedFrom:before.n,loadMs:performance.now()-started};save('load',report);
    if(loaded%5000===0)console.log(table,loaded,'elapsedSec',Math.round((performance.now()-started)/1000));
  }
  const idx=performance.now();await indexTags(pool,S,table);report.tables[table].indexMs=performance.now()-idx;
  assert.equal(Number((await pool.query(`SELECT count(*)::int n FROM ${S}.b_${table}_tags WHERE scope_id=$1`,[B_SCOPE])).rows[0].n),100000);
  save('load',report);
}
report.finished=new Date().toISOString();save('load',report);
}catch(e:any){report.error=e.stack;save('load',report);throw e;}finally{unlock();await pool.end();}
