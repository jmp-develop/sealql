import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
export {assert};
export const OUT='bench/results/2026-09-29-attack-extra';
export const fields=['name','phone','address','memo','email','company'] as const;
export const scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
export async function connect(){const db=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});await assertDisposable(db);assert.equal((await db.query('show port')).rows[0].port,'56439');return db;}
export function rng(seed=714029){let s=seed>>>0;return ()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/4294967296;};}
export function shuffled<T>(xs:T[],seed=714029){const a=[...xs],r=rng(seed);for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
export type Row={id:string}&Record<typeof fields[number],string>;
export async function loadRows(){const db=await connect();try{return shuffled((await db.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers order by id`)).rows as Row[]);}finally{await db.end();}}
export async function fixture(){const db=await connect();try{const meta=await db.query("select table_name,column_name from information_schema.columns where table_schema='bench_realistic_100k' order by table_name,ordinal_position");console.log(meta.rows);return meta.rows;}finally{await db.end();}}
if(process.argv.includes('--inspect'))await fixture();
