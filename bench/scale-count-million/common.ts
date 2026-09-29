import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {Pool} from 'pg';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {assertDisposable} from '../../test/disposable.js';
export const OUT='bench/results/2026-09-29-scale-count-million',schema='test_scale_count_million_v_astra',scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',fields=['name','phone','address','memo','email','company'] as const;
const lock='.local/research/measure.lock',owner=`scale-count-million-v-astra ${process.pid}`;
export async function acquire(){for(;;){try{writeFileSync(lock,owner,{flag:'wx'});return;}catch(e){if((e as any).code!=='EEXIST')throw e;await delay(1000);}}}
export function release(){if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}
export async function locked<T>(fn:()=>Promise<T>):Promise<T>{await acquire();try{return await fn();}finally{release();}}
export async function connect(max=1){const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max,idleTimeoutMillis:0,options:'-c statement_timeout=1200000'});try{await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);return pool;}catch(e){await pool.end();throw e;}}
export function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
export function status(subject:string,body:string){if(subject!=='100만 복제·VACUUM 완료')return;execFileSync('rtk',['proxy','orca','orchestration','send','--from','term_2207b6c8-c853-4009-869e-e401f52ddd8e','--to','term_be20cdd8-e2cf-4cef-be5b-574b2d2a0233','--type','status','--subject',subject,'--body',body,'--report-path',OUT+'/progress.json'],{stdio:'inherit'});}
export const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
export const cloneId=(id:string,rep:string)=>`md5('count-million:'||${id}::text||':'||${rep}::text)::uuid`;
export {assert,readFileSync,delay};
