import assert from 'node:assert/strict';
import {createDecipheriv} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {Client,Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
import {plainWhere,type Node} from '../verify-native/r8-cases.js';
import {B_SCOPE,verification} from './b-codec.js';
import {candidate} from './b-product.js';
import {customerFields} from './b-storage.js';
import {company,type BCase} from './b-cases.js';

export const S='research_u',OUT='bench/results/2026-09-28-unified';
export const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:12,options:'-c statement_timeout=180000'});
await assertDisposable(pool);assert.equal(Number((await pool.query('SHOW port')).rows[0].port),56439);
const keys=JSON.parse(readFileSync('.local/research/unified-keys.json','utf8'));
assert.equal(keys.prfKey,Buffer.alloc(32,7).toString('hex'));assert.equal(keys.aesKey,Buffer.alloc(32,93).toString('hex'));
const AES=Buffer.from(keys.aesKey,'hex');
const lockPath='.local/research/measure.lock',owner='m1-astra-unified '+process.pid;let held=false;
export async function lock(){while(true){try{writeFileSync(lockPath,owner+' '+new Date().toISOString(),{flag:'wx'});held=true;console.log('lock acquired',owner);return;}catch(e:any){if(e.code!=='EEXIST')throw e;console.log('lock waiting',readFileSync(lockPath,'utf8').trim());await new Promise(r=>setTimeout(r,15000));}}}
export function unlock(){if(held&&existsSync(lockPath)&&readFileSync(lockPath,'utf8').startsWith(owner)){unlinkSync(lockPath);held=false;}}
export function save(phase:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/m1-astra-${phase}.json`,JSON.stringify(data,null,2)+'\n');}
type Event={start:number;end:number;rows:number};let events:Event[]|null=null,opens=0;
const query=Client.prototype.query;
(Client.prototype as any).query=function(...args:any[]){const start=performance.now();let recorded=false;const record=(r:any)=>{if(!recorded){recorded=true;events?.push({start,end:performance.now(),rows:r?.rows?.length??0});}return r;};const cb=args.findIndex(x=>typeof x==='function');if(cb>=0){const fn=args[cb];args[cb]=(e:any,r:any)=>{record(r);fn(e,r);};}const r=(query as any).apply(this,args);return cb<0&&r?.then?r.then(record):r;};
export async function measured(fn:()=>Promise<any>){assert.equal(events,null);events=[];opens=0;const start=performance.now();try{const value=await fn(),end=performance.now(),ev:Event[]=[...events].sort((a,b)=>a.start-b.start);const dbMs=ev.reduce((a,b)=>a+b.end-b.start,0);let dbWallMs=0,right=-Infinity;for(const e of ev){dbWallMs+=Math.max(0,e.end-Math.max(e.start,right));right=Math.max(right,e.end);}const preMs=ev.length?ev[0].start-start:end-start,postMs=ev.length?end-right:0;return {value,totalMs:end-start,preMs,dbMs,dbWallMs,betweenSqlMs:end-start-preMs-dbWallMs-postMs,postMs,sqlCalls:ev.length,rowsToApp:ev.reduce((a,b)=>a+b.rows,0),openCount:opens};}finally{events=null;}}
export const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
export const summarize=(xs:any[])=>Object.fromEntries(Object.keys(xs[0]).filter(k=>k!=='value').map(k=>[k,median(xs.map(x=>x[k]))]));
export function decrypt(b:Buffer){opens++;const d=createDecipheriv('aes-256-gcm',AES,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
export function plainPredicate(node:Node,params:unknown[],alias:string){return plainWhere(node,params).replace(/\b(name|phone|address|memo|email|company)_norm\b/g,`${alias}.$1_norm`);}
export async function plain(c:BCase){const join=c.mode.startsWith('join'),params:unknown[]=[B_SCOPE];let from=`${S}.customers_plain p`,where=`p.scope_id=$1 AND ${plainPredicate(c.node,params,'p')}`;
  if(join){from=`${S}.tickets_plain p JOIN ${S}.customers_plain c ON c.id=p.customer_id AND c.scope_id=p.scope_id`;where+=` AND ${plainPredicate(company,params,'c')}`;}
  const list=c.mode==='find'||c.mode==='joinFind';const projection=list?(join?`p.id,p.memo_norm t_memo,${customerFields.map(f=>`c.${f}_norm c_${f}`).join(',')}`:`p.id,${customerFields.map(f=>`p.${f}_norm ${f}`).join(',')}`):c.mode==='sum'?'coalesce(sum(p.memo_len),0)::int n':'count(*)::int n';
  const rows=(await pool.query(`SELECT ${projection} FROM ${from} WHERE ${where}${list?` ORDER BY p.id${c.limit?' LIMIT '+c.limit:''}`:''}`,params)).rows;return list?rows:Number(rows[0].n);
}
export async function compile(c:BCase,onlyCandidates=false){const join=c.mode.startsWith('join'),table=join?'tickets':'customers',params:unknown[]=[B_SCOPE];
  const cand=await candidate(c.node,table,params,'j'),verify=onlyCandidates?'TRUE':verification(c.node,table,params,'j');
  const list=c.mode==='find'||c.mode==='joinFind';
  if(join){const cc=await candidate(company,'customers',params,'cj'),cv=onlyCandidates?'TRUE':verification(company,'customers',params,'cj');
    if(list&&!onlyCandidates){
      // OFFSET 0 prevents decorrelation: judge only while streaming ordered candidates to LIMIT.
      const text=`WITH matched AS MATERIALIZED (
        SELECT j.id,t.customer_id FROM
        (SELECT j.* FROM ${S}.b_tickets_tags j WHERE j.scope_id=$1 AND ${cand} ORDER BY j.id OFFSET 0) j
        CROSS JOIN LATERAL (SELECT customer_id FROM ${S}.tickets_ct p WHERE p.id=j.id OFFSET 0) t
        WHERE ${verify} AND EXISTS(SELECT 1 FROM ${S}.b_customers_tags cj WHERE cj.id=t.customer_id AND cj.scope_id=$1 AND ${cc} AND ${cv} OFFSET 0)
        ORDER BY j.id${c.limit?' LIMIT '+c.limit:''})
        SELECT t.id,t.memo_ct t_memo,${customerFields.map(f=>`p.${f}_ct c_${f}`).join(',')}
        FROM matched m JOIN ${S}.tickets_ct t ON t.id=m.id JOIN ${S}.customers_ct p ON p.id=m.customer_id ORDER BY t.id`;
      return {text,params};
    }
    return {text:`SELECT count(*)::int n FROM ${S}.b_tickets_tags j JOIN ${S}.tickets_ct t ON t.id=j.id JOIN ${S}.b_customers_tags cj ON cj.id=t.customer_id AND cj.scope_id=j.scope_id WHERE j.scope_id=$1 AND ${cand} AND ${verify} AND ${cc} AND ${cv}`,params};
  }
  if(list&&!onlyCandidates){
    const text=`WITH matched AS MATERIALIZED (SELECT j.id FROM
      (SELECT j.* FROM ${S}.b_customers_tags j WHERE j.scope_id=$1 AND ${cand} ORDER BY j.id OFFSET 0) j
      WHERE ${verify} ORDER BY j.id${c.limit?' LIMIT '+c.limit:''})
      SELECT p.id,${customerFields.map(f=>`p.${f}_ct ${f}`).join(',')} FROM matched m JOIN ${S}.customers_ct p ON p.id=m.id ORDER BY p.id`;
    return {text,params};
  }
  return {text:`SELECT ${c.mode==='sum'&&!onlyCandidates?'coalesce(sum(p.memo_len),0)::int':'count(*)::int'} n FROM ${S}.b_customers_tags j${c.mode==='sum'&&!onlyCandidates?` JOIN ${S}.customers_ct p ON p.id=j.id`:''} WHERE j.scope_id=$1 AND ${cand} AND ${verify}`,params};
}
export async function runB(c:BCase,onlyCandidates=false){const q=await compile(c,onlyCandidates);const rows=(await pool.query(q.text,q.params)).rows;if(onlyCandidates||!(c.mode==='find'||c.mode==='joinFind'))return Number(rows[0].n);const fs=c.mode==='joinFind'?['t_memo',...customerFields.map(f=>'c_'+f)]:[...customerFields];return rows.map(r=>({id:r.id,...Object.fromEntries(fs.map(f=>[f,decrypt(r[f])]))}));}
