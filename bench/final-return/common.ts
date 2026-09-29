import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync,existsSync} from 'node:fs';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
export const OUT='bench/results/2026-09-29-final-return',scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const fields=['name','phone','address','memo','email','company'] as const;
const lock='.local/research/measure.lock',inheritedOwner=process.env.SEALQL_MEASURE_LOCK_OWNER,owner=inheritedOwner??`final-return-v-astra ${process.pid}`;
export function acquire(){if(inheritedOwner){assert.equal(readFileSync(lock,'utf8'),owner,'Runner lock must remain owned');return;}writeFileSync(lock,owner,{flag:'wx'});}
export function release(){if(!inheritedOwner&&existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}
export function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
export async function connect(max=1){const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});try{await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);return pool;}catch(error){await pool.end();release();throw error;}}
export const normalize=(v:string)=>v.normalize('NFC').replace(/[！-～]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xff01+0x21)).replace(/[A-Z]/g,c=>c.toLowerCase()).replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g,'');
export {assert,readFileSync};
export type Leaf={field:string;op:'eq'|'contains'|'startsWith'|'endsWith'|'like';value:string};
export type Node=Leaf|{all:Node[]}|{any:Node[]};
export type Case={name:string;node:Node};
export function condition(n:Node):string{return 'all'in n?'('+n.all.map(condition).join(' AND ')+')':'any'in n?'('+n.any.map(condition).join(' OR ')+')':`${n.field} ${n.op} ${JSON.stringify(n.value)}`;}
export const median=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b),i=a.length>>1;return a.length%2?a[i]:(a[i-1]+a[i])/2;};
