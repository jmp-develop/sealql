/** Isolated b_w_* fixture authorized in unified-contract.md; shared source tables are never changed. */
import assert from 'node:assert/strict';
import {createCipheriv,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {S,pool,lock,unlock,save,measured,median,summarize,decrypt,compile} from './b-runtime.js';
import {customerFields,insertTags,updateTag,deleteTags} from './b-storage.js';
import {B_SCOPE} from './b-codec.js';
import {broad,company,type BCase} from './b-cases.js';
const AES=Buffer.from(JSON.parse(readFileSync('.local/research/unified-keys.json','utf8')).aesKey,'hex');
const encrypt=(value:string)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',AES,iv);const ct=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),ct]);};
type Path='plain'|'B';type Op='insert'|'update'|'delete'|'concurrent8';
const only=process.argv[2]==='all'?undefined:process.argv[2];assert(!only||['insert','update','delete','concurrent8'].includes(only));
const stopAt=process.argv[3]?Date.parse(process.argv[3]):Infinity;assert(!Number.isNaN(stopAt));
function deadline(){assert(Date.now()<stopAt,'coordinator lock handoff deadline; incomplete operation not measured');}
const report:any={started:new Date().toISOString(),source:'shared customers_plain ordered by source UUID, original IDs and values only',schema:S,fixture:['b_w_plain','b_w_ct','b_w_tags'],warmups:2,repetitions:7,writeRows:{insert:300,update:100,delete:100,concurrent8:8000},transactions:'one row per committed transaction; 8 writers each insert 1000 rows',cipher:'same shared AES-GCM format; shared AAD status must be considered separately',cases:[]};
async function tx(client:any,fn:()=>Promise<any>){await client.query('BEGIN');try{const r=await fn();await client.query('COMMIT');return r;}catch(e){await client.query('ROLLBACK');throw e;}}
async function insert(client:any,path:Path,r:any){deadline();const vals=customerFields.map(f=>r[f+'_norm']);if(path==='plain'){await client.query(`INSERT INTO ${S}.b_w_plain VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[r.id,r.scope_id,...vals,Array.from(r.memo_norm).length]);return;}
 await tx(client,async()=>{await client.query(`INSERT INTO ${S}.b_w_ct VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[r.id,r.scope_id,...vals.map(encrypt),Array.from(r.memo_norm).length]);await insertTags(client,S,'customers',[r],'b_w_tags');});}
async function patch(client:any,path:Path,r:any,memo:string){deadline();if(path==='plain'){await client.query(`UPDATE ${S}.b_w_plain SET memo_norm=$2,memo_len=$3 WHERE id=$1`,[r.id,memo,Array.from(memo).length]);return;}
 await tx(client,async()=>{await client.query(`UPDATE ${S}.b_w_ct SET memo_ct=$2,memo_len=$3 WHERE id=$1`,[r.id,encrypt(memo),Array.from(memo).length]);await updateTag(client,S,'customers',r.id,'memo',memo,'b_w_tags');});}
async function remove(client:any,path:Path,r:any){deadline();if(path==='plain'){await client.query(`DELETE FROM ${S}.b_w_plain WHERE id=$1`,[r.id]);return;}
 await tx(client,async()=>{await deleteTags(client,S,'customers',[r.id],'b_w_tags');await client.query(`DELETE FROM ${S}.b_w_ct WHERE id=$1`,[r.id]);});}
async function reset(path:Path,rows:any[]){await pool.query(path==='plain'?`TRUNCATE ${S}.b_w_plain`:`TRUNCATE ${S}.b_w_ct,${S}.b_w_tags`);if(!rows.length)return;const c=await pool.connect();try{for(const r of rows)await insert(c,path,r);}finally{c.release();}}
async function assertState(path:Path,expected:any[]){const broadExpected=expected.filter(r=>r.memo_norm.includes('서비스')).length,companyExpected=expected.filter(r=>r.company_norm==='서울서비스담당').length;
 let memo:number,co:number;
 if(path==='plain'){const r=(await pool.query(`SELECT count(*) FILTER(WHERE memo_norm LIKE '%서비스%')::int memo,count(*) FILTER(WHERE company_norm='서울서비스담당')::int company FROM ${S}.b_w_plain`)).rows[0];memo=r.memo;co=r.company;}
 else{const run=async(node:any)=>{const q=await compile({name:'write-check',node,mode:'count'} as BCase);return Number((await pool.query(q.text.replaceAll(`${S}.b_customers_tags`,`${S}.b_w_tags`),q.params)).rows[0].n);};memo=await run(broad);co=await run(company);}
 assert.equal(memo,broadExpected,'post-write memo count');assert.equal(co,companyExpected,'post-write company count');
 const table=path==='plain'?'b_w_plain':'b_w_ct';const rows=(await pool.query(`SELECT * FROM ${S}.${table} ORDER BY id`)).rows;assert.equal(rows.length,expected.length);
 if(path==='B')assert.equal(Number((await pool.query(`SELECT count(*)::int n FROM ${S}.b_w_tags`)).rows[0].n),expected.length);
 const byId=new Map(expected.map(r=>[r.id,r]));for(const r of rows){const original=byId.get(r.id);assert(original);for(const f of customerFields)assert.equal(path==='B'?decrypt(r[f+'_ct']):r[f+'_norm'],original[f+'_norm'],`post-write ${f} value`);}
 return {rows:rows.length,memo,company:co,allCipherValuesChecked:path==='B'};
}
try{await lock();
 for(const [name,source]of [['b_w_plain','customers_plain'],['b_w_ct','customers_ct'],['b_w_tags','b_customers_tags']])await pool.query(`CREATE TABLE IF NOT EXISTS ${S}.${name} (LIKE ${S}.${source} INCLUDING ALL)`);
 const src=(await pool.query(`SELECT * FROM ${S}.customers_plain WHERE scope_id=$1 ORDER BY id LIMIT 10000`,[B_SCOPE])).rows;assert.equal(src.length,10000);
 for(const op of (only?[only]:['insert','update','delete','concurrent8']) as Op[]){const r:any={op,rows:report.writeRows[op],first:{},runs:{plain:[],B:[]},checks:[],failed:{}};report.cases.push(r);
 try{for(let round=-2;round<7;round++)for(const path of (round%2?['B','plain']:['plain','B']) as Path[]){
   const initial=op==='update'||op==='delete'?src.slice(0,300):[];await reset(path,initial);
   let unchanged:any;if(op==='update'&&path==='B')unchanged=(await pool.query(`SELECT j.ce_company,j.cs_company,j.salt_company,j.jt_company,j.jx_company,c.company_ct FROM ${S}.b_w_tags j JOIN ${S}.b_w_ct c USING(id) WHERE id=$1`,[src[0].id])).rows[0];
   const expected=op==='insert'?src.slice(0,300):op==='delete'?src.slice(100,300):op==='concurrent8'?src.slice(2000,10000):src.slice(0,300).map((x,i)=>i<100?{...x,memo_norm:src[300+i].memo_norm}:x);
   const stat=await measured(async()=>{const latencies:number[]=[];
     if(op==='concurrent8'){await Promise.all(Array.from({length:8},async(_,worker)=>{const c=await pool.connect();try{for(const row of src.slice(2000+worker*1000,3000+worker*1000)){const t=performance.now();await insert(c,path,row);latencies.push(performance.now()-t);}}finally{c.release();}}));}
     else{const c=await pool.connect();try{for(let i=0;i<report.writeRows[op];i++){const t=performance.now();if(op==='insert')await insert(c,path,src[i]);else if(op==='update')await patch(c,path,src[i],src[300+i].memo_norm);else await remove(c,path,src[i]);latencies.push(performance.now()-t);}}finally{c.release();}}
     return {medianRowLatencyMs:median(latencies)};
   });
   const {value,...metrics}=stat;const record={...metrics,medianRowLatencyMs:value.medianRowLatencyMs,wallMsPerRow:stat.totalMs/report.writeRows[op],rowsPerSec:report.writeRows[op]*1000/stat.totalMs};
   if(round===-2)r.first[path]=record;if(round>=0)r.runs[path].push(record);
   const check=await assertState(path,expected);r.checks.push({round,path,...check});
   if(unchanged){const after=(await pool.query(`SELECT j.ce_company,j.cs_company,j.salt_company,j.jt_company,j.jx_company,c.company_ct FROM ${S}.b_w_tags j JOIN ${S}.b_w_ct c USING(id) WHERE id=$1`,[src[0].id])).rows[0];assert.deepEqual(after,unchanged,'unmodified company bytes');}
   save('write',report);console.log(op,round,path,record.totalMs.toFixed(1),JSON.stringify(check));
 }
 r.summary={plain:summarize(r.runs.plain),B:summarize(r.runs.B)};r.ratios={plain:1,B:r.summary.B.totalMs/r.summary.plain.totalMs};r.rowLatencyRatios={plain:1,B:r.summary.B.medianRowLatencyMs/r.summary.plain.medianRowLatencyMs};
 }catch(e:any){r.failed.B=String(e.stack??e).replaceAll(process.cwd()+'\\','').replaceAll(process.cwd()+'/','');save('write',report);throw e;}
 save('write',report);
 }
 report.finished=new Date().toISOString();save('write',report);
}finally{unlock();await pool.end();}
