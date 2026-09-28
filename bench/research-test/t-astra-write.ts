/** Same existing 20 rows, committed managed INSERT, including transaction completion. */
import assert from 'node:assert/strict';
import {eq} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/node-postgres';
import {S,pool,scope,fields,sealed,customers,lock,unlock,putTags,save,measured,summary} from './t-astra-common.js';
try{await lock();const rows=(await pool.query(`select * from ${S}.customers_plain order by id limit 20`)).rows;
const result:any={rowsPerBatch:20,encryptedFields:6,tagFields:2,scope:'committed managed INSERT; preparatory DELETE outside measurement; BEGIN/savepoint/encryption/index/optional tags/COMMIT included',first:{},runs:{product:[],A:[]}};
const client=await pool.connect();try{const db=drizzle(client);for(let i=-2;i<7;i++)for(const path of (i%2?['A','product']:['product','A'])){
await db.transaction(async tx=>{for(const row of rows)await tx.delete(customers.table).where(eq(customers.table.id,row.id));});
const stats=await measured(async()=>{await db.transaction(async tx=>{await sealed.insert(tx,customers.seal,rows.map(r=>({id:r.id,scopeId:scope,...Object.fromEntries(fields.map(f=>[f,r[f+'_plain']]))})) as any);if(path==='A')await putTags(client,'customers',rows);});return rows.length;});
assert.equal((await client.query(`select count(*)::int n from ${S}.customers where id=any($1::uuid[])`,[rows.map(r=>r.id)])).rows[0].n,20);
if(path==='product')await putTags(client,'customers',rows); // restore the A fixture outside baseline measurement
const {value,...stat}=stats;if(i===-2)result.first[path]=stat;if(i>=0)result.runs[path].push({...stat,msPerRow:stat.totalMs/rows.length});}
result.summary=Object.fromEntries(Object.entries(result.runs).map(([p,x])=>[p,summary(x as any[])]));result.restoredRows=(await pool.query(`select count(*)::int n from ${S}.customers`)).rows[0].n;assert.equal(result.restoredRows,100000);save('write',result);console.log(JSON.stringify(result.summary));}finally{client.release();}}finally{unlock();await pool.end();}
