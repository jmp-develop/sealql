import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,rmSync,existsSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {sql,eq,and} from 'drizzle-orm';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {createSealer} from '../../src/index.js';
import {createSealed} from '../../src/adapters/drizzle/v0.45/index.js';
import {assertDisposable} from '../../test/disposable.js';

const OUT='bench/results/2026-09-29-followup/wal',schema='test_followup_wal_astra';
const work=resolve('.local',`wal-astra-${Date.now()}`),segments=join(work,'segments'),images=join(work,'images');
mkdirSync(OUT,{recursive:true});mkdirSync(segments,{recursive:true});mkdirSync(images,{recursive:true});
const save=(name:string,value:any)=>writeFileSync(`${OUT}/${name}.json`,JSON.stringify(value,null,2)+'\n');
const cleanDump=(value:string)=>value.split(/\r?\n/).map(line=>line.trimEnd()).join('\n');
const fields=['name','phone','address','memo','email','company'] as const,scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sealed=createSealed({sealer:createSealer({key:new Uint8Array(32).fill(93)})});
const table=pgSchema(schema).table('customers',{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:true}})]))});
const seal=sealed.register(table,{row:'id',scope:'scopeId'});
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,options:'-c statement_timeout=120000'});
const log:any[]=[];let capture=false;
const orm=drizzle(pool,{logger:{logQuery(query,params){if(capture)log.push({query,params});}}});
const result:any={started:new Date().toISOString(),schema,sourceRows:64,insertedRows:32,phases:[],relations:[],snapshots:{},complete:false};
const snapshots:Record<string,{parent:any[];index:any[]}>={};let created=false;
const lsnNumber=(s:string)=>{const [a,b]=s.split('/');return (BigInt('0x'+a)<<32n)+BigInt('0x'+b);};
const lsn=async()=>String((await pool.query('select pg_current_wal_insert_lsn() as lsn')).rows[0].lsn);
const snapshot=async(name:string,runner:any=pool)=>{snapshots[name]={parent:(await runner.query(`select * from ${schema}.customers order by id`)).rows,index:(await runner.query(`select * from ${schema}.customers_seal_index order by row_id`)).rows};result.snapshots[name]={rows:snapshots[name].parent.length};};
const relations=new Map<string,any>();
async function collectRelations(){const rows=(await pool.query(`with base as (select oid,reltoastrelid from pg_class where relnamespace=$1::regnamespace), owned as (select oid from base union select reltoastrelid from base where reltoastrelid<>0), all_owned as (select oid from owned union select indexrelid from pg_index where indrelid in(select oid from owned)) select c.relname,c.relkind,pg_relation_filenode(c.oid)::text node,coalesce(nullif(c.reltablespace,0),(select dattablespace from pg_database where datname=current_database()))::text spc,(select oid::text from pg_database where datname=current_database()) db from pg_class c where c.oid in(select oid from all_owned)`,[schema])).rows;for(const r of rows)if(r.node){const key=[r.spc,r.db,r.node].join('/');relations.set(key,{...r,key});}}
async function phase(name:string,fn:()=>Promise<void>){const start=await lsn();await fn();const end=await lsn();result.phases.push({name,start,end});console.log(name,start,end);save('progress',result);}
function buffers(value:any,out:Buffer[]){if(Buffer.isBuffer(value)||value instanceof Uint8Array)out.push(Buffer.from(value));else if(Array.isArray(value))value.forEach(v=>buffers(v,out));else if(typeof value==='string'){for(const m of value.matchAll(/\\x([0-9a-f]{64})/gi))out.push(Buffer.from(m[1],'hex'));}}
function needles(s:{parent:any[];index:any[]}){const out:{kind:string;bytes:Buffer}[]=[];for(const row of s.parent)for(const [k,v]of Object.entries(row))if(Buffer.isBuffer(v)){out.push({kind:'ciphertext',bytes:v});out.push({kind:'ciphertextBodyAndTag',bytes:v.subarray(13)});}for(const row of s.index)for(const [k,v]of Object.entries(row)){if(Buffer.isBuffer(v))out.push({kind:k.includes('salt')?'salt':'bytea',bytes:v});else if(typeof v==='string'&&k.includes('stamp')){const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(v));out.push({kind:'exactStamp',bytes:b});}else if(Array.isArray(v)&&v.length){if(typeof v[0]==='string'){const b=Buffer.alloc(v.length*8);v.forEach((x,i)=>b.writeBigInt64LE(BigInt(x),i*8));out.push({kind:k.includes('token')?'tokenArray':'stampArray',bytes:b});}else if(typeof v[0]==='number'){const b=Buffer.alloc(v.length*4);v.forEach((x,i)=>b.writeInt32LE(x,i*4));out.push({kind:'offsetArray',bytes:b});}}}return out;}
// Decode only complete, bounded pglz varlena candidates; matches are then checked against actual DB values.
// Format source: PostgreSQL REL_18_STABLE src/common/pg_lzcompress.c and src/include/varatt.h.
function inflated(data:Buffer):Buffer[]{const out:Buffer[]=[];for(let p=0;p+8<data.length;p++){
 const h=data.readUInt32LE(p);if((h&3)!==2)continue;const size=h>>>2;if(size<9||p+size>data.length)continue;
 const tc=data.readUInt32LE(p+4),raw=tc&0x3fffffff;if(tc>>>30||raw<32||raw>1024*1024||raw<=size-8)continue;
 const src=data.subarray(p+8,p+size),dst=Buffer.alloc(raw);let i=0,j=0,valid=true;
 while(i<src.length&&j<raw&&valid){const ctrl=src[i++];for(let bit=0;bit<8&&i<src.length&&j<raw;bit++){
  if(ctrl&(1<<bit)){if(i+2>src.length){valid=false;break;}let len=(src[i]&15)+3;const off=((src[i]&240)<<4)|src[i+1];i+=2;if(len===18){if(i>=src.length){valid=false;break;}len+=src[i++];}if(off===0||off>j||j+len>raw){valid=false;break;}for(let k=0;k<len;k++){dst[j]=dst[j-off];j++;}}
  else dst[j++]=src[i++];
 }}if(valid&&i===src.length&&j===raw)out.push(dst);
 }return out;}
try{
 await assertDisposable(pool);assert.equal((await pool.query('show port')).rows[0].port,'56439');
 result.commit=spawnSync('rtk',['proxy','git','rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
 result.settings=(await pool.query("select name,setting,unit from pg_settings where name in ('server_version','wal_level','wal_compression','full_page_writes','wal_log_hints','data_checksums','wal_segment_size','synchronous_commit','log_statement','log_min_duration_statement') order by name")).rows;
 const dataDir=resolve((await pool.query('show data_directory')).rows[0].data_directory),opts=readFileSync(join(dataDir,'postmaster.opts'),'utf8');
 const binary=opts.slice(0,opts.indexOf(' "-D"')).replace(/^"|"$/g,'');const waldump=join(dirname(binary),'pg_waldump.exe');assert.ok(existsSync(waldump));
 result.waldumpVersion=spawnSync('rtk',['proxy',waldump,'--version'],{encoding:'utf8'}).stdout.trim();assert.match(result.waldumpVersion,/PostgreSQL\) 18/);
 assert.equal((await pool.query('select to_regnamespace($1) as n',[schema])).rows[0].n,null);await pool.query(`create schema ${schema}`);created=true;
 for(const statement of await generateMigration(generateDrizzleJson({}),generateDrizzleJson({table,seal})))await pool.query(statement);
 for(const statement of sealed.extraMigrationSql(seal))await pool.query(statement);
 const source=(await pool.query(`select id,scope_id as "scopeId",${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id limit 64`)).rows;assert.equal(source.length,64);
 await collectRelations();
 const captureStart=await lsn();
 await phase('insert32',async()=>{await sealed.insert(orm,seal,source.slice(0,32));await snapshot('initial');});
 await phase('fullpage_rewrite',async()=>{await pool.query(`vacuum full ${schema}.customers`);await pool.query(`vacuum full ${schema}.customers_seal_index`);await collectRelations();await snapshot('afterRewrite');assert.deepEqual(snapshots.afterRewrite,snapshots.initial);});
 await phase('update8',async()=>{for(let i=0;i<8;i++)await sealed.update(orm,seal,{id:source[i].id,scopeId:scope},{memo:source[32+i].memo});await snapshot('afterUpdate');});
 await phase('delete8',async()=>{for(let i=8;i<16;i++)await orm.delete(table).where(and(eq(table.id,source[i].id),eq(table.scopeId,scope)));await snapshot('afterDelete');assert.equal(snapshots.afterDelete.parent.length,24);assert.equal(snapshots.afterDelete.index.length,24);});
 await phase('rollback4',async()=>{try{await orm.transaction(async tx=>{result.rollbackXid=(await tx.execute(sql`select pg_current_xact_id()::text as xid`)).rows[0].xid;await sealed.insert(tx,seal,source.slice(48,52));await snapshot('insideRollback',{query:(text:string)=>tx.execute(sql.raw(text))});throw new Error('deliberate rollback');});assert.fail('rollback expected');}catch(error){assert.equal((error as Error).message,'deliberate rollback');}await snapshot('afterRollback');assert.deepEqual(snapshots.afterRollback,snapshots.afterDelete);});
 const truth=source.slice(0,32).filter((_:any,i:number)=>i<8||i>=16).map((r:any)=>({...r,memo:source.findIndex((s:any)=>s.id===r.id)<8?source[32+source.findIndex((s:any)=>s.id===r.id)].memo:r.memo}));
 await phase('select_count_search',async()=>{
  capture=true;
  const expected=truth.filter((r:any)=>r.memo.replaceAll(' ','').includes('서비스')).length;
  const count=await sealed.count(orm,seal,{scope,match:m=>m.memo.contains('서비스')});assert.equal(count,expected);
  const page=await sealed.findMany(orm,seal,{scope,match:m=>m.memo.contains('서비스'),limit:300});assert.equal(page.items.length,expected);
  const byId=new Map(truth.map((r:any)=>[r.id,r]));for(const row of page.items)for(const f of fields)assert.equal((row as any)[f],(byId.get(row.id) as any)[f]);
  const likeExpected=truth.filter((r:any)=>/세종.*대로/.test(r.address.replaceAll(' ',''))).length;
  const likeCount=await sealed.count(orm,seal,{scope,match:m=>m.address.like('%세종%대로%')});assert.equal(likeCount,likeExpected);
  capture=false;result.queryChecks={count,likeCount,listRows:page.items.length,openedFields:page.items.length*fields.length,sqlCalls:log.length};
 });
 const protectedEnd=await lsn();
 const subset=(snap:any,ids:Set<string>)=>({parent:snap.parent.filter((r:any)=>ids.has(r.id)),index:snap.index.filter((r:any)=>ids.has(r.row_id))});
 snapshots.deletedPrior=subset(snapshots.initial,new Set(source.slice(8,16).map((r:any)=>r.id)));
 snapshots.abortedOnly=subset(snapshots.insideRollback,new Set(source.slice(48,52).map((r:any)=>r.id)));
 const changed=(before:any,after:any,old:boolean)=>{const output:any={parent:[],index:[]};for(const group of ['parent','index'])for(const next of after[group]){const id=group==='parent'?'id':'row_id',prior=before[group].find((r:any)=>r[id]===next[id]);if(!prior)continue;const cells:any={};for(const key of Object.keys(next))if(JSON.stringify(prior[key])!==JSON.stringify(next[key]))cells[key]=old?prior[key]:next[key];if(Object.keys(cells).length)output[group].push(cells);}return output;};
 snapshots.updatedBefore=changed(snapshots.initial,snapshots.afterUpdate,true);snapshots.updatedAfter=changed(snapshots.initial,snapshots.afterUpdate,false);
 for(const [name,snap]of Object.entries(snapshots))result.snapshots[name]??={rows:snap.parent.length};
 // Positive control: the same fixture value intentionally stored as plaintext, after the protected interval.
 await pool.query(`create table ${schema}.plain_control(value text)`);await collectRelations();
 await phase('plaintext_positive_control',async()=>{await pool.query(`insert into ${schema}.plain_control values($1)`,[source[0].memo]);});
 const captureEnd=await lsn();
 // A local committed write flushes the preceding capture prefix; no checkpoint or segment switch needed.
 assert.equal(result.settings.find((s:any)=>s.name==='synchronous_commit').setting,'on');
 await pool.query('begin');await pool.query(`update ${schema}.plain_control set value=value`);await pool.query('commit');
 assert.ok(lsnNumber((await pool.query('select pg_current_wal_flush_lsn() as lsn')).rows[0].lsn)>=lsnNumber(captureEnd));
 result.capture={start:captureStart,protectedEnd,end:captureEnd,globalSpanIncludesOtherWriters:true};
 const segmentSize=BigInt((await pool.query("select pg_size_bytes(current_setting('wal_segment_size'))::text as n")).rows[0].n),firstFile=(await pool.query('select pg_walfile_name($1::pg_lsn) as f',[captureStart])).rows[0].f,timeline=firstFile.slice(0,8),perLog=0x100000000n/segmentSize;
 const segmentName=(pos:bigint)=>{const n=pos/segmentSize;return timeline+(n/perLog).toString(16).padStart(8,'0').toUpperCase()+(n%perLog).toString(16).padStart(8,'0').toUpperCase();};
 for(let pos=lsnNumber(captureStart)/segmentSize*segmentSize;pos<lsnNumber(captureEnd);pos+=segmentSize){const file=segmentName(pos);copyFileSync(join(dataDir,'pg_wal',file),join(segments,file));}
 const cache=new Map<string,Buffer>();const readBytes=(pos:bigint,n:number)=>{const file=segmentName(pos);let b=cache.get(file);if(!b){b=readFileSync(join(segments,file));cache.set(file,b);}return b.subarray(Number(pos%segmentSize),Number(pos%segmentSize)+n);};
 function recordBytes(start:bigint,size:number){let pos=start,left=size;const chunks:Buffer[]=[];while(left){if(pos%8192n===0n){const hdr=readBytes(pos,4);pos+=BigInt((hdr.readUInt16LE(2)&2)?40:24);}const n=Math.min(left,8192-Number(pos%8192n));const chunk=readBytes(pos,n);assert.equal(chunk.length,n);chunks.push(chunk);left-=n;pos+=BigInt(n);}return Buffer.concat(chunks);}
 const records=new Map<string,{lsn:string;total:number;text:string;bytes:Buffer}>();
 for(const [relation,meta]of relations){
  const imageDir=join(images,meta.node);mkdirSync(imageDir,{recursive:true});
  const dump=spawnSync('rtk',['proxy',waldump,'-p',segments,'-s',captureStart,'-e',captureEnd,'-R',relation,'-b','--save-fullpage='+imageDir],{encoding:'utf8',maxBuffer:64*1024*1024});
  assert.equal(dump.status,0,`${relation}: ${dump.stderr}`);if(dump.stdout.trim())writeFileSync(`${OUT}/wal-${meta.node}.txt`,cleanDump(dump.stdout));
  for(const line of dump.stdout.split(/\r?\n/)){const m=line.match(/len \(rec\/tot\):\s*(\d+)\/\s*(\d+).*?lsn: ([0-9A-F]+\/[0-9A-F]+)/);if(m&&!records.has(m[3]))records.set(m[3],{lsn:m[3],total:Number(m[2]),text:line,bytes:recordBytes(lsnNumber(m[3]),Number(m[2]))});}
 }
 result.relations=[...relations.values()];
 const abortDump=spawnSync('rtk',['proxy',waldump,'-p',segments,'-s',captureStart,'-e',captureEnd,'-x',result.rollbackXid,'-r','Transaction'],{maxBuffer:1024*1024});assert.equal(abortDump.status,0,abortDump.stderr.toString());const abortText=new TextDecoder('euc-kr').decode(abortDump.stdout);assert.match(abortText,/ABORT/);writeFileSync(`${OUT}/rollback-transaction.txt`,cleanDump(abortText));
 const imagesData=readdirSync(images).flatMap(dir=>readdirSync(join(images,dir)).map(name=>({name,bytes:readFileSync(join(images,dir,name))})));
 result.fullpageImages=imagesData.map(v=>({name:v.name,bytes:v.bytes.length,sha256:createHash('sha256').update(v.bytes).digest('hex')}));
 const protectedRecords=[...records.values()].filter(r=>lsnNumber(r.lsn)<lsnNumber(protectedEnd));
 const protectedImages=imagesData.filter(v=>{const m=v.name.match(/^[0-9A-F]+-([0-9A-F]+)-([0-9A-F]+)\./i);return !!m&&lsnNumber(m[1]+'/'+m[2])<lsnNumber(protectedEnd);});
 const found=(needle:Buffer,buffers:Buffer[])=>buffers.some(b=>b.includes(needle));
 const bytes=protectedRecords.map(r=>r.bytes),fpi=protectedImages.map(r=>r.bytes),decodedRecords=bytes.flatMap(inflated),decodedImages=fpi.flatMap(inflated);
 result.pglzDecoded={recordCandidates:decodedRecords.length,imageCandidates:decodedImages.length};
 const allBytes=[...bytes,...decodedRecords],allFpi=[...fpi,...decodedImages];
 const plainNeedles=[...new Set([...source.flatMap((r:any)=>fields.map(f=>r[f])),'서비스','%세종%대로%','세종대로'])].filter(v=>Buffer.byteLength(v)>=6).map(v=>Buffer.from(v));
 const queryBuffers:Buffer[]=[];for(const entry of log)buffers(entry.params,queryBuffers);const keys=[...new Map(queryBuffers.filter(b=>b.length===32).map(b=>[b.toString('hex'),b])).values()];
 assert.ok(keys.length>0,'Capture actual bound query keys');
 result.negativeChecks={plaintextNeedles:plainNeedles.length,plaintextRecordHits:plainNeedles.filter(b=>found(b,allBytes)).length,plaintextImageHits:plainNeedles.filter(b=>found(b,allFpi)).length,queryKeys:keys.length,queryKeyRecordHits:keys.filter(b=>found(b,allBytes)).length,queryKeyImageHits:keys.filter(b=>found(b,allFpi)).length};
 for(const [name,snap]of Object.entries(snapshots)){const groups:any={};for(const needle of needles(snap)){const g=groups[needle.kind]??={tested:0,recordHits:0,imageHits:0,recordOrPglzHits:0,imageOrPglzHits:0};g.tested++;g.recordHits+=Number(found(needle.bytes,bytes));g.imageHits+=Number(found(needle.bytes,fpi));g.recordOrPglzHits+=Number(found(needle.bytes,allBytes));g.imageOrPglzHits+=Number(found(needle.bytes,allFpi));}result.snapshots[name].evidence=groups;}
 for(const phase of result.phases){const rr=[...records.values()].filter(r=>lsnNumber(r.lsn)>=lsnNumber(phase.start)&&lsnNumber(r.lsn)<lsnNumber(phase.end)),raw=rr.map(r=>r.bytes),decoded=[...raw,...raw.flatMap(inflated)];phase.ownRecords=rr.length;phase.descriptions=rr.reduce((o:any,r)=>{const type=r.text.match(/desc: ([^,]+)/)?.[1]??'unknown';o[type]=(o[type]??0)+1;return o;},{});phase.rawPlaintextHits=plainNeedles.filter(b=>found(b,raw)).length;phase.queryKeyHits=keys.filter(b=>found(b,decoded)).length;
  const name:Record<string,string>={insert32:'initial',fullpage_rewrite:'initial',update8:'updatedAfter',delete8:'deletedPrior',rollback4:'abortedOnly'};
  if(name[phase.name]){const stats:any={};for(const needle of needles(snapshots[name[phase.name]])){const g=stats[needle.kind]??={tested:0,rawHits:0,withPglzHits:0};g.tested++;g.rawHits+=Number(found(needle.bytes,raw));g.withPglzHits+=Number(found(needle.bytes,decoded));}phase.phaseOnlyEvidence=stats;}
 }
 const controlPhase=result.phases.find((p:any)=>p.name==='plaintext_positive_control');assert.ok(controlPhase.rawPlaintextHits>0);
 assert.equal(result.negativeChecks.plaintextRecordHits,0);assert.equal(result.negativeChecks.plaintextImageHits,0);assert.equal(result.negativeChecks.queryKeyRecordHits,0);assert.equal(result.negativeChecks.queryKeyImageHits,0);
 result.ownRecords=records.size;result.method='pg_waldump relation filters, copied flushed capture prefix, reconstruct each record across WAL page headers, and uncompressed --save-fullpage images; byte-needle presence is not full PITR replay';result.complete=true;
 const kept=new Set([...relations.values()].map(r=>`wal-${r.node}.txt`));for(const name of readdirSync(OUT))if(/^wal-\d+\.txt$/.test(name)&&(!kept.has(name)||readFileSync(join(OUT,name)).length===0))unlinkSync(join(OUT,name));if(existsSync(join(OUT,'progress.json')))unlinkSync(join(OUT,'progress.json'));
}catch(error){result.error=(error as Error).message.replaceAll(work,'<temporary-work>').replaceAll(resolve('.'),'<repository>');throw error;}finally{
 if(created){await pool.query(`drop schema ${schema} cascade`);result.schemaDeleted=(await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n===null;}
 await pool.end();result.finished=new Date().toISOString();save('result',result);
 assert.ok(work.startsWith(resolve('.local')+sep)&&work.includes('wal-astra-'));rmSync(work,{recursive:true,force:true});
}
console.log(JSON.stringify({complete:result.complete,negative:result.negativeChecks,records:result.ownRecords,fpi:result.fullpageImages.length,deleted:result.schemaDeleted}));
