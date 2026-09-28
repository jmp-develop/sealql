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
const S='research_u',OUT='bench/results/2026-09-29-task4',LOCK='.local/research/measure.lock',owner=`m1-astra-task4-write ${process.pid}`;
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,idleTimeoutMillis:0,options:'-c statement_timeout=120000'}),db=drizzle(pool);
const sealer=createSealer({key:Buffer.alloc(32,93)}),sealed=createSealed({sealer}),schema=pgSchema(S),search={exact:true,substring:{wordBoundary:true,skipGrams:true}} as const;
const aTable=schema.table('pb_4_w_a',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search})]))});
const aIndex=sealed.register(aTable,{row:'id',scope:'scopeId',model:'customers'});
const paths=['plain','A','final'] as const;type Path=typeof paths[number];type Op='insert'|'update'|'delete';
const names={plain:'pb_4_w_plain',A:'pb_4_w_a',final:'pb_4_w_final_ct'},tags='pb_4_w_final_tags';
const med=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
const save=(data:any)=>writeFileSync(OUT+'/write.json',JSON.stringify(data,null,2)+'\n');
const ctx=(f:string,id:string)=>({modelId:'customers',fieldId:f,keyScopeId:'global',scopeId:B_SCOPE,rowId:id,spec:{type:'text' as const}});
const pkey=(f:string,piece:string)=>createHmac('sha256',Buffer.alloc(32,7)).update([B_SCOPE,'customers',f,'pb1b-w2-n2',piece].join('\0')).digest();
async function field(f:string,value:string,id:string){
 const norm=normalize(value),chars=Array.from(norm),salt=randomBytes(16),psalt=randomBytes(16),seen=new Map<string,number>(),pairs:{s:bigint;p:number}[]=[],cache=new Map<string,Buffer>();
 const tokens=await writeTokens('customers',f,norm);if(f==='company')tokens.ce=[String((BigInt(String(tokens.ce[0]))>>30n)&3n)];
 for(let p=0;p+2<=chars.length;p++){const piece=chars.slice(p,p+2).join('');let k=cache.get(piece);if(!k){k=pkey(f,piece);cache.set(piece,k);}const i=(seen.get(piece)??0)+1;seen.set(piece,i);const b=Buffer.alloc(4);b.writeUInt32BE(i);pairs.push({s:hash('sha256',Buffer.concat([k,psalt,b]),'buffer').readBigInt64BE(),p});}
 pairs.sort((a,b)=>a.s<b.s?-1:a.s>b.s?1:0);for(let i=1;i<pairs.length;i++)assert.notEqual(pairs[i-1].s,pairs[i].s);
 return {ct:Buffer.from(await sealer.seal(norm,ctx(f,id),sealer.ring('customers'))),values:[tokens.ce,tokens.cs,salt,judge(pieceKey('customers',f,{kind:'x',value:norm}),salt),psalt,chars.length,pairs.map(p=>String(p.s)),pairs.map(p=>p.p)]};
}
async function tx(fn:()=>Promise<any>){await pool.query('BEGIN');try{const r=await fn();await pool.query('COMMIT');return r;}catch(e){await pool.query('ROLLBACK');throw e;}}
async function write(path:Path,op:Op,row:any,memo?:string){
 if(path==='A'){
  if(op==='insert')await sealed.insert(db,aIndex,{id:row.id,scopeId:B_SCOPE,...Object.fromEntries(fields.map(f=>[f,row[f+'_norm']]))} as any);
  else if(op==='update')await sealed.update(db,aIndex,{id:row.id,scopeId:B_SCOPE},{memo} as any);
  else await db.transaction(async t=>{await t.delete(aTable).where(and(eq(aTable.id,row.id),eq(aTable.scopeId,B_SCOPE)));});
  return;
 }
 if(path==='plain'){await tx(async()=>{if(op==='insert')await pool.query(`INSERT INTO ${S}.${names.plain}(id,scope_id,${fields.map(f=>f+'_norm').join(',')},memo_len) VALUES(${Array.from({length:9},(_,i)=>'$'+(i+1)).join(',')})`,[row.id,B_SCOPE,...fields.map(f=>row[f+'_norm']),Array.from(row.memo_norm).length]);else if(op==='update')await pool.query(`UPDATE ${S}.${names.plain} SET memo_norm=$2,memo_len=$3 WHERE id=$1`,[row.id,memo,Array.from(memo!).length]);else await pool.query(`DELETE FROM ${S}.${names.plain} WHERE id=$1`,[row.id]);});return;}
 if(op==='delete'){await tx(()=>pool.query(`DELETE FROM ${S}.${names.final} WHERE id=$1 AND scope_id=$2`,[row.id,B_SCOPE]));return;}
 const fs=op==='insert'?fields:['memo'] as const,prepared:Awaited<ReturnType<typeof field>>[]=[];for(const f of fs)prepared.push(await field(f,op==='update'?memo!:row[f+'_norm'],row.id));
 await tx(async()=>{
  if(op==='insert'){
   await pool.query(`INSERT INTO ${S}.${names.final}(id,scope_id,${fields.map(f=>f+'_ct').join(',')}) VALUES(${Array.from({length:8},(_,i)=>'$'+(i+1)).join(',')})`,[row.id,B_SCOPE,...prepared.map(p=>p.ct)]);
   const values=[row.id,B_SCOPE,...prepared.flatMap(p=>p.values)];await pool.query(`INSERT INTO ${S}.${tags} VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')})`,values);
  }else{
   await pool.query(`UPDATE ${S}.${names.final} SET memo_ct=$2 WHERE id=$1 AND scope_id=$3`,[row.id,prepared[0].ct,B_SCOPE]);
   const cols=['ce','cs','salt','jx','psalt','n','stamps','positions'].map(p=>p+'_memo');await pool.query(`UPDATE ${S}.${tags} SET ${cols.map((c,i)=>c+'=$'+(i+2)).join(',')} WHERE id=$1 AND scope_id=$10`,[row.id,...prepared[0].values,B_SCOPE]);
  }
 });
}
async function reset(path:Path,rows:any[]){const body=`${S}.${names[path]}`,index=path==='A'?`${S}.pb_4_w_a_seal_index`:path==='final'?`${S}.${tags}`:null;await pool.query(`TRUNCATE ${body}${index?','+index:''}`);if(!rows.length)return;const ids=rows.map(r=>r.id);await tx(async()=>{
 if(path==='plain')await pool.query(`INSERT INTO ${body} SELECT * FROM ${S}.customers_plain WHERE id=ANY($1::uuid[])`,[ids]);
 else{await pool.query(`INSERT INTO ${body} SELECT * FROM native_verify_main.customers WHERE id=ANY($1::uuid[])`,[ids]);if(path==='A')await pool.query(`INSERT INTO ${index} SELECT * FROM native_verify_main.customers_seal_index WHERE row_id=ANY($1::uuid[])`,[ids]);else await pool.query(`INSERT INTO ${index} SELECT * FROM ${S}.pb_4_final WHERE id=ANY($1::uuid[])`,[ids]);}
 });}
async function unmodified(path:Path,ids:string[]){const fs=fields.filter(f=>f!=='memo');if(path==='plain')return(await pool.query(`SELECT id,${fs.map(f=>f+'_norm').join(',')} FROM ${S}.${names.plain} WHERE id=ANY($1::uuid[]) ORDER BY id`,[ids])).rows;
 const cols=path==='A'?fs.flatMap(f=>[sourceTokenColumn('customers',f,true),sourceTokenColumn('customers',f,false)]).map(c=>'j.'+c):fs.flatMap(f=>['ce','cs','salt','jx','psalt','n','stamps','positions'].map(p=>'j.'+p+'_'+f));
 return(await pool.query(`SELECT p.id,${fs.map(f=>'p.'+f+'_ct').join(',')},${cols.join(',')} FROM ${S}.${names[path]} p JOIN ${S}.${path==='A'?'pb_4_w_a_seal_index':tags} j ON ${path==='A'?'j.row_id':'j.id'}=p.id WHERE p.id=ANY($1::uuid[]) ORDER BY p.id`,[ids])).rows;
}
async function verify(path:Path,expected:any[]){
 const rows=(await pool.query(`SELECT * FROM ${S}.${names[path]} ORDER BY id`)).rows;assert.equal(rows.length,expected.length);const byId=new Map(expected.map(r=>[r.id,r]));
 for(const row of rows){const original=byId.get(row.id);assert(original);for(const f of fields){const value=path==='plain'?row[f+'_norm']:normalize(String(await sealer.open(row[f+'_ct'],ctx(f,row.id),sealer.ring('customers'))));assert.equal(value,original[f+'_norm'],`value ${path}/${f}`);}}
 if(path!=='plain')assert.equal(Number((await pool.query(`SELECT count(*)::int n FROM ${S}.${path==='A'?'pb_4_w_a_seal_index':tags}`)).rows[0].n),expected.length);
 const cases:Node[]=[{field:'company',op:'eq',value:'서울서비스 담당'},{field:'memo',op:'contains',value:'서비스'}];const counts=[];
 for(const node of cases){assert(!('all'in node)&&!('any'in node));const want=expected.filter(r=>node.op==='eq'?r[node.field+'_norm']===normalize(node.value):r[node.field+'_norm'].includes(normalize(node.value))).length;let got:number;
  if(path==='plain')got=Number((await pool.query(`SELECT count(*)::int n FROM ${S}.${names.plain} WHERE ${node.field}_norm ${node.op==='eq'?'=$1':"LIKE '%'||$1||'%'"}`,[normalize(node.value)])).rows[0].n);
  else if(path==='A')got=Number(await sealed.count(db,aIndex,{scope:B_SCOPE,match:(m:any)=>m[node.field][node.op](node.value)} as any));
  else{const params:unknown[]=[B_SCOPE],cand=await candidate(node,'customers',params,'j');let judgeSql:string;if(node.op==='eq'){params[params.length-1]=String((BigInt(String(params.at(-1)))>>30n)&3n);judgeSql=verification(node,'customers',params,'j');}else{params.push(pkey('memo','서비'),pkey('memo','비스'));judgeSql=`${S}.pb_4_match(ARRAY[$${params.length-1}::bytea,$${params.length}::bytea],ARRAY[0,1],3,j.n_memo,j.psalt_memo,j.stamps_memo,j.positions_memo,0)`;}got=Number((await pool.query(`SELECT count(*)::int n FROM ${S}.${tags} j WHERE j.scope_id=$1 AND ${cand} AND ${judgeSql}`,params)).rows[0].n);}
  assert.equal(got,want,`post-write count ${path}/${node.field}`);counts.push(got);
 }
 return {rows:rows.length,valuesChecked:rows.length*6,counts,tagRowsMatch:true};
}
let events:{s:number;e:number;rows:number}[]|null=null;const original=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){const s=performance.now();let done=false;const record=(r:any)=>{if(!done){done=true;events?.push({s,e:performance.now(),rows:r?.rows?.length??0});}return r;};const cb=args.findIndex(a=>typeof a==='function');if(cb>=0){const old=args[cb];args[cb]=(e:any,r:any)=>{record(r);old(e,r);};}const r=(original as any).apply(this,args);return cb<0&&r?.then?r.then(record):r;};
async function timed(fn:()=>Promise<number[]>){events=[];const start=performance.now();try{const latencies=await fn(),end=performance.now(),ev=[...events];const pre=ev[0].s-start,post=end-ev.at(-1)!.e,dbMs=ev.reduce((s,e)=>s+e.e-e.s,0);return {totalMs:end-start,dbMs,preMs:pre,postMs:post,betweenMs:end-start-pre-post-dbMs,sqlCalls:ev.length,appRows:ev.reduce((s,e)=>s+e.rows,0),medianRowMs:med(latencies),wallMsPerRow:(end-start)/latencies.length,rowsPerSecond:latencies.length*1000/(end-start)};}finally{events=null;}}
let held=false;const report:any={started:new Date().toISOString(),paths,warmups:2,repeats:7,firstSeparate:true,source:'same fixture IDs and normalized values; resets copy native ciphertext read-only',deleteA:'public API has no sealed.delete; Drizzle parent delete + FK cascade within transaction',transactions:'one row per committed transaction',cases:[],checks:[]};
try{
 await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);writeFileSync(LOCK,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;report.pid=(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const clones=[['pb_4_w_plain','research_u.customers_plain'],['pb_4_w_a','native_verify_main.customers'],['pb_4_w_a_seal_index','native_verify_main.customers_seal_index'],['pb_4_w_final_ct','native_verify_main.customers'],[tags,'research_u.pb_4_final']];
 for(const [t,source] of clones){assert.equal((await pool.query('SELECT to_regclass($1) r',[S+'.'+t])).rows[0].r,null,'new write tables only');await pool.query(`CREATE TABLE ${S}.${t} (LIKE ${source} INCLUDING ALL)`);}
 await pool.query(`ALTER TABLE ${S}.pb_4_w_a_seal_index ADD FOREIGN KEY(row_id) REFERENCES ${S}.pb_4_w_a(id) ON DELETE CASCADE`);
 await pool.query(`ALTER TABLE ${S}.${tags} ADD FOREIGN KEY(id) REFERENCES ${S}.pb_4_w_final_ct(id) ON DELETE CASCADE`);
 const src=(await pool.query(`SELECT * FROM ${S}.customers_plain WHERE scope_id=$1 ORDER BY id LIMIT 400`,[B_SCOPE])).rows;assert.equal(src.length,400);
 for(const op of ['insert','update','delete'] as Op[]){const count=op==='insert'?300:100,row:any={op,rows:count,first:{},runs:Object.fromEntries(paths.map(p=>[p,[]])),summary:{}};report.cases.push(row);
  for(let round=-3;round<7;round++){const offset=(round+3)%paths.length;for(const path of [...paths.slice(offset),...paths.slice(0,offset)]){
   await reset(path,op==='insert'?[]:src.slice(0,300));const before=op==='update'?await unmodified(path,src.slice(0,100).map(r=>r.id)):null;
   const metric=await timed(async()=>{const times=[];for(let i=0;i<count;i++){const t=performance.now();await write(path,op,src[i],op==='update'?src[300+i].memo_norm:undefined);times.push(performance.now()-t);}return times;});
   const expected=op==='insert'?src.slice(0,300):op==='delete'?src.slice(100,300):src.slice(0,300).map((r,i)=>i<100?{...r,memo_norm:src[300+i].memo_norm}:r);
   const check=await verify(path,expected);if(before)assert.deepEqual(await unmodified(path,src.slice(0,100).map(r=>r.id)),before,'memo update must preserve all other ciphertext/token/stamp bytes');report.checks.push({op,round,path,...check,unmodifiedFieldsInvariant:op==='update'});
   if(round===-3)row.first[path]=metric;if(round>=0)row.runs[path].push(metric);save(report);console.log(op,round,path,Math.round(metric.totalMs),new Date().toISOString());
  }}
  for(const path of paths){row.summary[path]=Object.fromEntries(Object.keys(row.runs[path][0]).map(k=>[k,med(row.runs[path].map((r:any)=>r[k]))]));row.summary[path].ratio=row.summary[path].totalMs/row.summary.plain.totalMs;}save(report);
 }
 report.finished=new Date().toISOString();assert.equal((await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid,report.pid);save(report);
}catch(e:any){report.error={at:new Date().toISOString(),message:e.message,stack:e.stack};save(report);throw e;}
finally{if(held&&existsSync(LOCK)&&readFileSync(LOCK,'utf8').startsWith(owner))unlinkSync(LOCK);await pool.end();}
