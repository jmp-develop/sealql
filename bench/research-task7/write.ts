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
const S='research_u',OUT='bench/results/2026-09-29-task7',LOCK='.local/research/measure.lock',owner=`m1-astra-task7-write ${process.pid}`;
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,idleTimeoutMillis:0,options:'-c statement_timeout=120000'}),db=drizzle(pool);
const sealer=createSealer({key:Buffer.alloc(32,93)}),sealed=createSealed({sealer}),schema=pgSchema(S),search={exact:true,substring:{wordBoundary:true,skipGrams:true}} as const;
const aTable=schema.table('pb_4_w_a',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search})]))});
const aIndex=sealed.register(aTable,{row:'id',scope:'scopeId',model:'customers'});
const paths=['plain','final','tag'] as const;type Path=typeof paths[number];type Op='insert'|'update'|'delete';
const names={plain:'pb_7_w_plain',final:'pb_7_w_final_ct',tag:'pb_7_w_tag_ct'},tags='pb_7_w_final_tags';
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
const tagTable=(p:Path)=>p==='final'?'pb_7_w_final_tags':'pb_7_w_tag_base';
const token=(v:string)=>hash('sha256',Buffer.concat([Buffer.alloc(32,7),Buffer.from(['customers','company','e',normalize(v)].join('\0'))]),'buffer');
const colPrefixes=['ce','cs','salt','jx','psalt','n','stamps','positions'];
let ev:{s:number;e:number;rows:number}[]|null=null;const originalQuery=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){const s=performance.now();let done=false;const record=(r:any)=>{if(!done){done=true;ev?.push({s,e:performance.now(),rows:r?.rows?.length??0});}return r;};const ci=args.findIndex(a=>typeof a==='function');if(ci>=0){const cb=args[ci];args[ci]=(e:any,r:any)=>{record(r);cb(e,r);};}const r=(originalQuery as any).apply(this,args);return ci<0&&r?.then?r.then(record):r;};
async function transaction(fn:()=>Promise<void>){await pool.query('BEGIN');try{await fn();await pool.query('COMMIT');}catch(e){await pool.query('ROLLBACK');throw e;}}
async function newTag(id:string,v:string){const tok=token(v);const n=(await pool.query("INSERT INTO research_u.pb_7_w_esc VALUES(sha256($1::bytea||'esc'::bytea),1) ON CONFLICT(tok) DO UPDATE SET n=pb_7_w_esc.n+1 RETURNING n",[tok])).rows[0].n;await pool.query('INSERT INTO research_u.pb_7_w_ctag VALUES(substr(sha256($1::bytea||int4send($2)),1,8),$3)',[tok,n,id]);}
async function change(p:Path,op:Op,r:any,value?:string){
 const fs=op==='insert'?fields:['company'] as const,prepared:any[]=[];
 if(p!=='plain'&&op!=='delete')for(const f of fs)prepared.push(await field(f,op==='update'?value!:r[f+'_norm'],r.id));
 await transaction(async()=>{
 if(p==='plain'){if(op==='insert')await pool.query(`INSERT INTO ${S}.${names.plain} SELECT * FROM ${S}.customers_plain WHERE id=$1`,[r.id]);else if(op==='update')await pool.query(`UPDATE ${S}.${names.plain} SET company_norm=$2 WHERE id=$1`,[r.id,value]);else await pool.query(`DELETE FROM ${S}.${names.plain} WHERE id=$1`,[r.id]);return;}
 if(op==='delete'){await pool.query(`DELETE FROM ${S}.${names[p]} WHERE id=$1`,[r.id]);return;}
 const encoded=prepared.flatMap((x,i)=>x.values.filter((_:any,j:number)=>p!=='tag'||fs[i]!=='company'||![0,2,3].includes(j)));
 if(op==='insert'){await pool.query(`INSERT INTO ${S}.${names[p]} VALUES(${Array.from({length:8},(_,i)=>'$'+(i+1)).join(',')})`,[r.id,B_SCOPE,...prepared.map(x=>x.ct)]);const vals=[r.id,B_SCOPE,...encoded];await pool.query(`INSERT INTO ${S}.${tagTable(p)} VALUES(${vals.map((_,i)=>'$'+(i+1)).join(',')})`,vals);}
 else{await pool.query(`UPDATE ${S}.${names[p]} SET company_ct=$2 WHERE id=$1`,[r.id,prepared[0].ct]);const cols=colPrefixes.filter(x=>p!=='tag'||!['ce','salt','jx'].includes(x)).map(x=>x+'_company');await pool.query(`UPDATE ${S}.${tagTable(p)} SET ${cols.map((x,i)=>x+'=$'+(i+2)).join(',')} WHERE id=$1`,[r.id,...encoded]);}
 if(p==='tag'){if(op==='update')await pool.query('DELETE FROM research_u.pb_7_w_ctag WHERE id=$1',[r.id]);await newTag(r.id,op==='update'?value!:r.company_norm);}
 });
}
async function reset(p:Path,ids:string[]){const tables=[names[p],...(p==='plain'?[]:[tagTable(p)]),...(p==='tag'?['pb_7_w_ctag','pb_7_w_esc']:[])];await pool.query(`TRUNCATE ${tables.map(t=>S+'.'+t).join(',')}`);if(!ids.length)return;
 await transaction(async()=>{await pool.query(`INSERT INTO ${S}.${names[p]} SELECT * FROM ${p==='plain'?S+'.customers_plain':'native_verify_main.customers'} WHERE id=ANY($1::uuid[])`,[ids]);if(p!=='plain')await pool.query(`INSERT INTO ${S}.${tagTable(p)} SELECT * FROM ${S}.${p==='final'?'pb_4_final':'pb_7_base'} WHERE id=ANY($1::uuid[])`,[ids]);if(p==='tag'){await pool.query(`INSERT INTO ${S}.pb_7_w_ctag SELECT * FROM ${S}.pb_7_ctag WHERE id=ANY($1::uuid[])`,[ids]);await pool.query(`INSERT INTO ${S}.pb_7_w_esc SELECT * FROM ${S}.pb_7_esc`);}});
}
async function verify(p:Path,expected:any[]){const rows=(await pool.query(`SELECT * FROM ${S}.${names[p]} ORDER BY id`)).rows;assert.equal(rows.length,expected.length);const map=new Map(expected.map(r=>[r.id,r]));for(const r of rows){const e=map.get(r.id);assert(e);for(const f of fields)assert.equal(p==='plain'?r[f+'_norm']:normalize(String(await sealer.open(r[f+'_ct'],ctx(f,r.id),sealer.ring('customers')))),e[f+'_norm']);}
 const distinct=[...new Set(expected.map(r=>r.company_norm))],counts=[];for(const value of distinct){const want=expected.filter(r=>r.company_norm===value).length;let got:number;if(p==='plain')got=(await pool.query(`SELECT count(*)::int n FROM ${S}.${names[p]} WHERE company_norm=$1`,[value])).rows[0].n;else if(p==='final'){const params:unknown[]=[B_SCOPE],n:Node={field:'company',op:'eq',value},cand=await candidate(n,'customers',params,'j');params[params.length-1]=String((BigInt(String(params.at(-1)))>>30n)&3n);const ver=verification(n,'customers',params,'j');got=(await pool.query(`SELECT count(*)::int n FROM ${S}.${tagTable(p)} j WHERE scope_id=$1 AND ${cand} AND ${ver}`,params)).rows[0].n;}else got=(await pool.query(`SELECT count(*)::int n FROM ${S}.pb_7_w_ctag WHERE tag8=ANY(ARRAY(SELECT substr(sha256($1::bytea||int4send(g)),1,8) FROM generate_series(1,coalesce((SELECT n FROM ${S}.pb_7_w_esc WHERE tok=sha256($1::bytea||'esc'::bytea)),0)) g))`,[token(value)])).rows[0].n;assert.equal(got,want);counts.push({value,count:got});}
 return {rows:rows.length,fields:rows.length*6,counts};
}
let held=false;const report:any={started:new Date().toISOString(),protocol:{warmups:2,repeats:7,first:1},cases:[],checks:[],ledgerReset:'update/delete seed uses 300 live fixture rows and preserved 100000-occurrence ledger; deleted historical occurrences stay absent'};
try{await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);writeFileSync(LOCK,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;report.pid=(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 for(const [t,src]of [[names.plain,S+'.customers_plain'],[names.final,'native_verify_main.customers'],[names.tag,'native_verify_main.customers'],[tags,S+'.pb_4_final'],['pb_7_w_tag_base',S+'.pb_7_base'],['pb_7_w_ctag',S+'.pb_7_ctag'],['pb_7_w_esc',S+'.pb_7_esc']]){assert.equal((await pool.query('SELECT to_regclass($1) r',[S+'.'+t])).rows[0].r,null);await pool.query(`CREATE TABLE ${S}.${t}(LIKE ${src} INCLUDING ALL)`);}
 for(const [t,body]of [[tags,names.final],['pb_7_w_tag_base',names.tag],['pb_7_w_ctag',names.tag]])await pool.query(`ALTER TABLE ${S}.${t} ADD FOREIGN KEY(id) REFERENCES ${S}.${body}(id) ON DELETE CASCADE`);
 const src=(await pool.query(`SELECT * FROM ${S}.customers_plain ORDER BY id LIMIT 400`)).rows;
 for(const op of ['insert','update','delete'] as Op[]){const n=op==='insert'?300:100,row:any={op,rows:n,runs:Object.fromEntries(paths.map(p=>[p,[]])),first:{},summary:{}};report.cases.push(row);
 for(let round=-3;round<7;round++){const off=(round+3)%3;for(const p of [...paths.slice(off),...paths.slice(0,off)]){await reset(p,op==='insert'?[]:src.slice(0,300).map(r=>r.id));const before=p==='tag'&&op==='delete'?(await pool.query('SELECT encode(tok,\'hex\') tok,n FROM research_u.pb_7_w_esc ORDER BY tok')).rows:null;
 const changed=(i:number)=>src.slice(300).find(r=>r.company_norm!==src[i].company_norm)!.company_norm;
 ev=[];const t=performance.now();for(let i=0;i<n;i++)await change(p,op,src[i],op==='update'?changed(i):undefined);const end=performance.now(),events=[...ev];ev=null;const dbMs=events.reduce((v,x)=>v+x.e-x.s,0),preMs=events[0].s-t,postMs=end-events.at(-1)!.e;const metric={totalMs:end-t,rows:n,dbMs,preMs,postMs,betweenMs:end-t-preMs-postMs-dbMs,sqlCalls:events.length,receivedRows:events.reduce((v,x)=>v+x.rows,0)};
 const expected=op==='insert'?src.slice(0,300):op==='delete'?src.slice(100,300):src.slice(0,300).map((r,i)=>i<100?{...r,company_norm:changed(i)}:r);report.checks.push({op,round,path:p,...await verify(p,expected)});if(before)assert.deepEqual((await pool.query('SELECT encode(tok,\'hex\') tok,n FROM research_u.pb_7_w_esc ORDER BY tok')).rows,before,'delete must not lower ledger');if(round===-3)row.first[p]=metric;if(round>=0)row.runs[p].push(metric);save(report);}}
 for(const p of paths){row.summary[p]=Object.fromEntries(Object.keys(row.runs[p][0]).map(k=>[k,med(row.runs[p].map((x:any)=>x[k]))]));row.summary[p].perRowMs=row.summary[p].totalMs/n;row.summary[p].ratio=row.summary[p].totalMs/row.summary.plain.totalMs;row.summary[p].sqlRatio=row.summary[p].dbMs/row.summary.plain.dbMs;}save(report);console.log('WRITE',op,JSON.stringify(row.summary));}
 report.finished=new Date().toISOString();save(report);
}catch(e:any){report.error={message:e.message,at:new Date().toISOString()};save(report);throw e;}finally{if(held&&existsSync(LOCK)&&readFileSync(LOCK,'utf8').startsWith(owner))unlinkSync(LOCK);await pool.end();}
