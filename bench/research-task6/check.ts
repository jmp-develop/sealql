/** Isolated task4 write benchmark. Only newly created pb_4_w_* tables are mutated. */
import assert from 'node:assert/strict';
import {createHmac,hash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {Pool,Client} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {and,eq} from 'drizzle-orm';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from 'sealql';
import {createSealed} from 'sealql/drizzle/v0.45';
import {assertDisposable} from '../../test/disposable.js';
import {fields,type Node} from '../verify-native/r8-cases.js';
import {B_SCOPE,normalize,pieceKey,judge,verification} from '../research-unified/b-codec.js';
import {writeTokens,candidate,sourceTokenColumn} from '../research-unified/b-product.js';
const S='research_u',OUT='bench/results/2026-09-29-task6',LOCK='.local/research/measure.lock',owner=`m1-astra-task6-write ${process.pid}`;
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:9,idleTimeoutMillis:0,options:'-c statement_timeout=120000'}),db=drizzle(pool);
const sealer=createSealer({key:Buffer.alloc(32,93)}),sealed=createSealed({sealer}),schema=pgSchema(S),search={exact:true,substring:{wordBoundary:true,skipGrams:true}} as const;
const aTable=schema.table('pb_4_w_a',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search})]))});
const aIndex=sealed.register(aTable,{row:'id',scope:'scopeId',model:'customers'});
const paths=['plain','A','final'] as const;type Path=typeof paths[number];type Op='insert'|'update'|'delete';
const names={plain:'pb_4_w_plain',A:'pb_4_w_a',final:'pb_4_w_final_ct'},tags='pb_4_w_final_tags';
const med=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
const save=(data:any)=>writeFileSync(OUT+'/result.json',JSON.stringify(data,null,2)+'\n');
const ctx=(f:string,id:string)=>({modelId:'customers',fieldId:f,keyScopeId:'global',scopeId:B_SCOPE,rowId:id,spec:{type:'text' as const}});
const pkey=(f:string,piece:string)=>createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers',f,'pb1b-w2-n2',piece].join('\0')).digest();
async function field(f:string,value:string,id:string){
 const norm=normalize(value),chars=Array.from(norm),salt=randomBytes(16),psalt=randomBytes(16),seen=new Map<string,number>(),pairs:{s:bigint;p:number}[]=[],cache=new Map<string,Buffer>();
 const tokens=await writeTokens('customers',f,norm);if(f==='company')tokens.ce=[String((BigInt(String(tokens.ce[0]))>>30n)&3n)];
 for(let p=0;p+2<=chars.length;p++){const piece=chars.slice(p,p+2).join('');let k=cache.get(piece);if(!k){k=pkey(f,piece);cache.set(piece,k);}const i=(seen.get(piece)??0)+1;seen.set(piece,i);const b=Buffer.alloc(4);b.writeUInt32BE(i);pairs.push({s:hash('sha256',Buffer.concat([k,psalt,b]),'buffer').readBigInt64BE(),p});}
 pairs.sort((a,b)=>a.s<b.s?-1:a.s>b.s?1:0);for(let i=1;i<pairs.length;i++)assert.notEqual(pairs[i-1].s,pairs[i].s);
 return {ct:Buffer.from(await sealer.seal(norm,ctx(f,id),sealer.ring('customers'))),values:[tokens.ce,tokens.cs,salt,judge(pieceKey('customers',f,{kind:'x',value:norm}),salt),psalt,chars.length,pairs.map(p=>String(p.s)),pairs.map(p=>p.p)]};
}
const report:any={started:new Date().toISOString(),protocol:'single observation; 8 dedicated writer connections x50 independent fixture IDs; per-row COMMIT',checks:[],join:{status:'미측정'}};let held=false;
async function prepared(row:any){const out=[];for(const f of fields)out.push(await field(f,row[f+'_norm'],row.id));return out;}
async function insertBody(c:any,row:any,ps:any[]){await c.query(`INSERT INTO research_u.pb_4_w_final_ct(id,scope_id,${fields.map(f=>f+'_ct').join(',')}) VALUES(${Array.from({length:8},(_,i)=>'$'+(i+1)).join(',')})`,[row.id,B_SCOPE,...ps.map(p=>p.ct)]);}
async function insertTags(c:any,row:any,ps:any[]){const values=[row.id,B_SCOPE,...ps.flatMap(p=>p.values)];await c.query(`INSERT INTO research_u.pb_4_w_final_tags VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')})`,values);}
async function insertPlain(c:any,row:any){await c.query(`INSERT INTO research_u.pb_4_w_plain SELECT * FROM research_u.customers_plain WHERE id=$1 AND scope_id=$2`,[row.id,B_SCOPE]);}
async function snapshot(){const out:any={};for(const t of ['pb_4_w_plain','pb_4_w_final_ct','pb_4_w_final_tags'])out[t]=(await pool.query(`SELECT count(*)::int n FROM research_u.${t}`)).rows[0].n;return out;}
async function verify(){
 const plain=(await pool.query('SELECT * FROM research_u.pb_4_w_plain ORDER BY id')).rows,body=(await pool.query('SELECT * FROM research_u.pb_4_w_final_ct ORDER BY id')).rows;
 assert.deepEqual(body.map(r=>r.id),plain.map(r=>r.id));const tagIds=(await pool.query('SELECT id FROM research_u.pb_4_w_final_tags ORDER BY id')).rows;assert.deepEqual(tagIds.map(r=>r.id),plain.map(r=>r.id));
 for(let i=0;i<plain.length;i++)for(const f of fields)assert.equal(normalize(String(await sealer.open(body[i][f+'_ct'],ctx(f,body[i].id),sealer.ring('customers')))),plain[i][f+'_norm']);
 const cases:Node[]=[{field:'company',op:'eq',value:'서울서비스 담당'},{field:'memo',op:'contains',value:'서비스'}],counts=[];
 for(const node of cases){assert(!('all'in node)&&!('any'in node));const params:unknown[]=[B_SCOPE],cand=await candidate(node,'customers',params,'j');let full:string;if(node.op==='eq'){params[params.length-1]=String((BigInt(String(params.at(-1)))>>30n)&3n);full=verification(node,'customers',params,'j');}else{params.push(pkey('memo','서비'),pkey('memo','비스'));full=`research_u.pb_4_match(ARRAY[$${params.length-1}::bytea,$${params.length}::bytea],ARRAY[0,1],3,j.n_memo,j.psalt_memo,j.stamps_memo,j.positions_memo,0)`;}
  const got=(await pool.query(`SELECT count(*)::int n FROM research_u.pb_4_w_final_tags j WHERE scope_id=$1 AND ${cand} AND ${full}`,params)).rows[0].n;
  const want=(await pool.query(`SELECT count(*)::int n FROM research_u.pb_4_w_plain WHERE scope_id=$1 AND ${node.field}_norm ${node.op==='eq'?'=$2':"LIKE '%'||$2||'%'"}`,[B_SCOPE,normalize(node.value)])).rows[0].n;assert.equal(got,want);counts.push({node,plain:want,final:got});}
 return {rows:plain.length,fieldsChecked:plain.length*6,counts,idsAndTagIdsMatch:true};
}
try{
 await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);writeFileSync(LOCK,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;
 report.before=await snapshot();report.beforeCheck=await verify();save(report);
 const source=(await pool.query(`SELECT p.* FROM research_u.customers_plain p WHERE p.scope_id=$1 AND NOT EXISTS(SELECT 1 FROM research_u.pb_4_w_final_ct c WHERE c.id=p.id) AND NOT EXISTS(SELECT 1 FROM research_u.pb_4_w_plain c WHERE c.id=p.id) ORDER BY p.id LIMIT 410`,[B_SCOPE])).rows;assert.equal(source.length,410);
 const writers=await Promise.all(Array.from({length:8},()=>pool.connect()));report.writerPids=await Promise.all(writers.map(async c=>(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid));assert.equal(new Set(report.writerPids).size,8);
 const begin=performance.now();try{report.writers=await Promise.all(writers.map(async(c,w)=>{let commits=0;const t=performance.now();for(const row of source.slice(w*50,(w+1)*50)){const ps=await prepared(row);await c.query('BEGIN');try{await insertBody(c,row,ps);await insertTags(c,row,ps);await insertPlain(c,row);await c.query('COMMIT');commits++;}catch(e){await c.query('ROLLBACK');throw e;}}return {writer:w,commits,totalMs:performance.now()-t};}));}finally{writers.forEach(c=>c.release());}
 report.concurrentSingleMs=performance.now()-begin;report.afterConcurrent=await snapshot();for(const t of Object.keys(report.before))assert.equal(report.afterConcurrent[t],report.before[t]+400);report.checks.push({phase:'after400commits',...await verify()});save(report);
 const rollbackStart=performance.now();report.rollbacks=[];
 for(let i=0;i<10;i++){const row=source[400+i],ps=await prepared(row),c=await pool.connect();let code:string|undefined;try{await c.query('BEGIN');await insertBody(c,row,ps);if(i>=5)await insertTags(c,row,ps);await c.query('SELECT 1/0');assert.fail('failure injection did not throw');}catch(e:any){code=e.code;await c.query('ROLLBACK');assert.equal(code,'22012');}finally{c.release();}report.rollbacks.push({id:row.id,stage:i<5?'after body, before tags':'after body and tags, before plaintext reference',sqlstate:code});}
 report.rollbackSingleMs=performance.now()-rollbackStart;report.afterRollback=await snapshot();assert.deepEqual(report.afterRollback,report.afterConcurrent);
 for(const t of Object.keys(report.before))assert.equal((await pool.query(`SELECT count(*)::int n FROM research_u.${t} WHERE id=ANY($1::uuid[])`,[source.slice(400).map(r=>r.id)])).rows[0].n,0);
 report.checks.push({phase:'after10rollbacks',...await verify()});save(report);
 const ticketTables=(await pool.query("SELECT table_name,array_agg(column_name ORDER BY ordinal_position) columns FROM information_schema.columns WHERE table_schema='research_u' AND table_name LIKE '%ticket%' GROUP BY table_name ORDER BY table_name")).rows;
 report.join={status:'미측정',predicate:'tickets.memo contains 서비스 AND customers.company = 서울서비스 담당',tables:ticketTables,reason:'Need populated B candidate + exact memo verifier for tickets; plaintext-only join is not an encrypted final-path measurement.'};
 for(const t of ticketTables){if(['tickets_plain','tickets_ct','b_tickets_tags'].includes(t.table_name))t.rows=(await pool.query(`SELECT count(*)::int n FROM research_u.${t.table_name}`)).rows[0].n;}
 report.finished=new Date().toISOString();save(report);console.log(JSON.stringify(report,null,2));
}catch(e:any){report.error={at:new Date().toISOString(),message:e.message,stack:e.stack};save(report);throw e;}
finally{if(held&&existsSync(LOCK)&&readFileSync(LOCK,'utf8').startsWith(owner))unlinkSync(LOCK);await pool.end();}
