import assert from 'node:assert/strict';
import {hash,createHmac,randomBytes} from 'node:crypto';
import {existsSync,writeFileSync,readFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {Pool,Client} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../../src/core/field-cipher.js';
import {createSealed,registrationOf} from '../../src/adapters/drizzle/v0.45/native.js';
import {normalizeText,profiles,searchPieces,searchTokens} from '../../src/core/search-tokens.js';
import {assertDisposable} from '../../test/disposable.js';
export const S='research_t_astra',OUT='bench/results/2026-09-28-count-test',scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',K=8;
export const fields=['name','phone','address','memo','email','company'] as const, tagFields=['memo','company'] as const;
export const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:10,options:'-c statement_timeout=120000'});
await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
export const db=drizzle(pool),sealer=createSealer({key:Buffer.alloc(32,93)}),sealed=createSealed({sealer});
export const search={exact:true,substring:{wordBoundary:true,skipGrams:true}} as const;
const schema=pgSchema(S);
function make(t:string):{table:any;seal:any}{const table:any=schema.table(t,{id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull(),...(t==='tickets'?{customerId:uuid('customer_id').notNull()}:{}),...Object.fromEntries(fields.map(f=>[f,sealed.text(f,{search})]))});return {table,seal:sealed.register(table,{row:'id',scope:'scopeId'})};}
export const customers=make('customers'),tickets=make('tickets');
export const entry=(t:string)=>t==='customers'?customers:tickets;
export const norm=(v:string)=>normalizeText(v,'legacy-text-v1');
export const keyPiece=(table:string,f:string,kind:string,value:string)=>createHmac('sha256',Buffer.alloc(32,3)).update([scope,table,f,kind,value].join('\0')).digest();
export const judge=(key:Buffer,salt:Buffer)=>BigInt.asIntN(64,hash('sha256',Buffer.concat([key,salt]),'buffer').readBigUInt64BE()).toString();
export function pieces(v:string){const c=Array.from(norm(v)),out=new Map<string,{kind:string,value:string}>();const add=(kind:string,value:string)=>out.set(kind+'\0'+value,{kind,value});for(let len=2;len<=Math.min(K,c.length);len++){for(let i=0;i+len<=c.length;i++)add('g',c.slice(i,i+len).join(''));add('s',c.slice(0,len).join(''));add('e',c.slice(-len).join(''));}return [...out.values()];}
export function encodeField(table:string,f:string,value:string){const salt=randomBytes(16);return {salt:salt.toString('hex'),jt:pieces(value).map(p=>judge(keyPiece(table,f,p.kind,p.value),salt)),jx:judge(keyPiece(table,f,'x',norm(value)),salt)};}
export async function putTags(client:any,table:string,rows:any[]){const vals=rows.map(r=>({id:r.id,...Object.fromEntries(tagFields.map(f=>[f,encodeField(table,f,r[`${f}_plain`]??r[f])]))}));await client.query(`insert into ${S}.${table}_tags select (x->>'id')::uuid,${tagFields.flatMap(f=>[`decode(x->'${f}'->>'salt','hex')`,`array(select jsonb_array_elements_text(x->'${f}'->'jt')::bigint)`,`(x->'${f}'->>'jx')::bigint`]).join(',')} from jsonb_array_elements($1::jsonb) x`,[JSON.stringify(vals)]);}
export type Leaf={field:string;op:'eq'|'contains'|'startsWith'|'endsWith';value:string};export type Tree=Leaf|{all:Tree[]}|{any:Tree[]};
export const match=(n:Tree,m:any):any=>'all'in n?m.and(...n.all.map(x=>match(x,m))):'any'in n?m.or(...n.any.map(x=>match(x,m))):m[n.field][n.op](n.value);
export const condition=(n:Tree):string=>'all'in n?'('+n.all.map(condition).join(' AND ')+')':'any'in n?'('+n.any.map(condition).join(' OR ')+')':`${n.field} ${n.op} "${n.value}"`;
export function plainWhere(n:Tree,params:any[],alias='p'):string{if('all'in n)return '('+n.all.map(x=>plainWhere(x,params,alias)).join(' and ')+')';if('any'in n)return '('+n.any.map(x=>plainWhere(x,params,alias)).join(' or ')+')';const v=norm(n.value);assert(!/[%_\\]/.test(v));params.push(v);const ph=`$${params.length}`,col=`${alias}.${n.field}_norm`;return n.op==='eq'?`${col}=${ph}`:`${col} like ${n.op==='startsWith'?'':"'%'||"}${ph}${n.op==='endsWith'?'':"||'%'"}`;}
const cache={profiles:new Map()};
export async function candidateWhere(n:Tree,table:string,params:any[],alias='i'):Promise<string>{if('all'in n)return '('+(await Promise.all(n.all.map(x=>candidateWhere(x,table,params,alias)))).join(' and ')+')';if('any'in n)return '('+(await Promise.all(n.any.map(x=>candidateWhere(x,table,params,alias)))).join(' or ')+')';const p=profiles(table,n.field,{type:'text',search}).find(p=>p.mode===(n.op==='eq'?'exact':'substring'))!;const ts=await searchTokens(sealer.ring(table),scope,p,searchPieces(p,n.value,n.op==='eq'?'write':n.op),cache);params.push(n.op==='eq'?ts[0]:ts);const col=registrationOf(entry(table).seal).storage.index!.profiles![p.indexId].tokens;return n.op==='eq'?`${alias}."${col}"[1] = $${params.length}::bigint`:`${alias}."${col}" @> $${params.length}::bigint[]`;}
export function verifyWhere(n:Tree,table:string,params:any[],alias='j'):string{if('all'in n)return '('+n.all.map(x=>verifyWhere(x,table,params,alias)).join(' and ')+')';if('any'in n)return '('+n.any.map(x=>verifyWhere(x,table,params,alias)).join(' or ')+')';const c=Array.from(norm(n.value));let ps:{kind:string,value:string}[]=[];if(n.op==='eq')ps=[{kind:'x',value:c.join('')}];else if(c.length<=K)ps=[{kind:n.op==='contains'?'g':n.op==='startsWith'?'s':'e',value:c.join('')}];else {if(n.op==='startsWith')ps.push({kind:'s',value:c.slice(0,K).join('')});if(n.op==='endsWith')ps.push({kind:'e',value:c.slice(-K).join('')});for(let i=0;i+K<=c.length;i++)ps.push({kind:'g',value:c.slice(i,i+K).join('')});}return '('+ps.map(p=>{params.push(keyPiece(table,n.field,p.kind,p.value));const tag=`('x'||encode(substr(sha256($${params.length}::bytea||${alias}.salt_${n.field}),1,8),'hex'))::bit(64)::bigint`;return n.op==='eq'?`${tag}=${alias}.jx_${n.field}`:`${tag}=any(${alias}.jt_${n.field})`;}).join(' and ')+')';}
export const lockFile='.local/research/measure.lock';const owner=`ASTRA-TEST ${process.pid}`;let held=false;
export async function lock(){if(process.env.ASTRA_CORRECTNESS_NOLOCK==='1'){assert(/t-astra-(edge|plan)\.ts$/.test(process.argv[1]),'exception only for coordinator-authorized correctness and non-ANALYZE plan');console.log('coordinator exception: correctness/plan only, no timing measurement');return;}while(true){try{writeFileSync(lockFile,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;console.log('lock acquired',owner);return;}catch(e:any){if(e.code!=='EEXIST')throw e;console.log('waiting lock',readFileSync(lockFile,'utf8'));await new Promise(r=>setTimeout(r,15000));}}}
export function unlock(){if(held&&existsSync(lockFile)&&readFileSync(lockFile,'utf8').startsWith(owner)){unlinkSync(lockFile);held=false;}}
export function save(name:string,v:any){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/t-astra-${name}.json`,JSON.stringify(v,null,2)+'\n');}
type Event={start:number,end:number,rows:number};let events:Event[]|null=null,opens=0;
const original=Client.prototype.query;(Client.prototype as any).query=function(...args:any[]){const start=performance.now();let recorded=false;const record=(r:any)=>{if(!recorded){recorded=true;events?.push({start,end:performance.now(),rows:r?.rows?.length??0});}return r;};const cb=args.findIndex(a=>typeof a==='function');if(cb>=0){const old=args[cb];args[cb]=(e:any,r:any)=>{record(r);old(e,r);};}const r=(original as any).apply(this,args);return cb<0&&r?.then?r.then(record):r;};
const open=sealer.open.bind(sealer);sealer.open=async(...args)=>{opens++;return open(...args);};
export async function measured(fn:()=>Promise<any>){events=[];opens=0;const start=performance.now();try{const value=await fn(),end=performance.now(),ev=events,dbMs=ev.reduce((s,e)=>s+e.end-e.start,0),preMs=ev.length?ev[0].start-start:end-start,postMs=ev.length?end-ev.at(-1)!.end:0;return {value,totalMs:end-start,preMs,dbMs,betweenSqlMs:end-start-preMs-dbMs-postMs,postMs,sqlCalls:ev.length,rowsToApp:ev.reduce((s,e)=>s+e.rows,0),openCount:opens};}finally{events=null;}}
export const median=(v:number[])=>[...v].sort((a,b)=>a-b)[v.length>>1];
export const summary=(xs:any[])=>Object.fromEntries(Object.keys(xs[0]).filter(k=>k!=='value').map(k=>[k,median(xs.map(x=>x[k]))]));
