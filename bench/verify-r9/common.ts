import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync,existsSync,copyFileSync} from 'node:fs';
import {Pool,Client} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from 'sealql';
import {createSealed} from 'sealql/drizzle/v0.45';
import {assertDisposable} from '../../test/disposable.js';

export const OUT='bench/results/2026-09-29-r9-verify';
export const scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const fields=['name','phone','address','memo','email','company'] as const;
export const lock='.local/research/measure.lock';
export const owner=`final-measure-v-astra ${process.pid}`;
export function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
export function archive(name:string){const path=`${OUT}/${name}.json`;if(existsSync(path))copyFileSync(path,`${OUT}/${name}-prior-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);}
export function acquire(){writeFileSync(lock,owner,{flag:'wx'});}
export function release(){if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}
export async function connect(max=1){
 const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});
 try{await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);return pool;}catch(error){await pool.end();release();throw error;}
}
export const cipher=createSealer({key:new Uint8Array(32).fill(93)});
export const sealed=createSealed({sealer:cipher});
export function model(schemaName:string,name='customers',ticket=false){
 const columns:any={id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull()};
 if(ticket)columns.customerId=uuid('customer_id').notNull();
 for(const f of fields)columns[f]=sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:{wordBoundary:true}}});
 const table=pgSchema(schemaName).table(name,columns),seal=sealed.register(table,{row:'id',scope:'scopeId'});return {table,seal};
}
export const fold=(v:string)=>v.normalize('NFC').replace(/[！-～]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xff01+0x21)).replace(/[A-Z]/g,c=>c.toLowerCase());
export const words=(v:string)=>fold(v).replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g,' ').trim();
export const normalize=(v:string)=>words(v).replaceAll(' ','');
export const median=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b),i=a.length>>1;return a.length%2?a[i]:(a[i-1]+a[i])/2;};
export type Leaf={field:string;op:'eq'|'contains'|'startsWith'|'endsWith'|'like';value:string;respectWords?:boolean};
export type Node=Leaf|{all:Node[]}|{any:Node[]};
export type Case={name:string;node:Node;respectWords?:boolean};
export function condition(n:Node):string{return 'all'in n?'('+n.all.map(condition).join(' AND ')+')':'any'in n?'('+n.any.map(condition).join(' OR ')+')':`${n.field} ${n.op} ${JSON.stringify(n.value)}${n.respectWords?' respectWords':''}`;}
export function match(n:Node,m:any):any{return 'all'in n?m.and(...n.all.map(c=>match(c,m))):'any'in n?m.or(...n.any.map(c=>match(c,m))):m[n.field][n.op](n.value,n.respectWords?{respectWords:true}:undefined);}
export function plainWhere(n:Node,params:unknown[],alias=''):string{
 if('all'in n)return '('+n.all.map(c=>plainWhere(c,params,alias)).join(' AND ')+')';
 if('any'in n)return '('+n.any.map(c=>plainWhere(c,params,alias)).join(' OR ')+')';
 assert(fields.includes(n.field as any));
 const escaped=(v:string)=>v.replace(/[\\%_]/g,c=>'\\'+c);
 const term=n.respectWords?words(n.value):normalize(n.value);
 const value=n.op==='like'?term:n.op==='eq'?term:n.op==='contains'?'%'+escaped(term)+'%':n.op==='startsWith'?escaped(term)+'%':'%'+escaped(term);
 params.push(value);return `${alias}${n.field}_norm ${n.op==='eq'?'=':'LIKE'} $${params.length}`;
}
export function normalizedRows(rows:any[]){return rows.map(r=>({id:String(r.id),...Object.fromEntries(fields.map(f=>[f,normalize(String(r[f]))]))}));}
type Event={start:number;end:number;rows:number;sql:string;pid:number};
let active:Event[]|undefined,opens=0;
const originalOpen=cipher.open.bind(cipher);cipher.open=async(...args)=>{if(active)opens++;return originalOpen(...args);};
const originalQuery=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){
 const capture=active,start=performance.now(),sql=typeof args[0]==='string'?args[0]:args[0]?.text??'',pid=this.processID;let done=false;
 const record=(r:any)=>{if(!done){done=true;capture?.push({start,end:performance.now(),rows:r?.rows?.length??0,sql,pid});}return r;};
 const ci=args.findIndex(x=>typeof x==='function');if(ci>=0){const cb=args[ci];args[ci]=(error:any,r:any)=>{record(r);cb(error,r);};}
 const result=(originalQuery as any).apply(this,args);return ci<0&&result?.then?result.then(record,(e:any)=>{record(undefined);throw e;}):result;
};
export async function measured(fn:()=>Promise<any>){
 assert.equal(active,undefined);active=[];opens=0;const start=performance.now();
 try{const value=await fn(),end=performance.now(),events=active.sort((a,b)=>a.start-b.start);let wall=0,right=-Infinity;for(const e of events){wall+=Math.max(0,e.end-Math.max(e.start,right));right=Math.max(right,e.end);}
 const pre=events.length?events[0].start-start:end-start,post=events.length?end-right:0;
 return {value,metric:{preMs:pre,sqlMs:events.reduce((s,e)=>s+e.end-e.start,0),betweenMs:Math.max(0,end-start-pre-wall-post),postMs:post,totalMs:end-start,sqlCalls:events.length,appRows:events.reduce((s,e)=>s+e.rows,0),opens},pids:[...new Set(events.map(e=>e.pid))],sql:events.map(e=>e.sql)};
 }finally{active=undefined;}
}
export function summarize(runs:any[]){assert.equal(runs.length,7);return Object.fromEntries(Object.keys(runs[0]).map(k=>[k,median(runs.map(r=>r[k]))]));}
export {assert,readFileSync,drizzle};
