import {mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {Pool} from 'pg';
import {assertDisposable} from '../../../test/disposable.js';
export {fields,scope,assert,normalize,type Node,type Case,median} from '../../final-return/common.js';
export const OUT='bench/results/2026-09-29-followup',schema='test_followup_product';
const lock='.local/research/measure.lock',owner=`followup-r9-impl ${process.pid}`;
export function acquire(){writeFileSync(lock,owner,{flag:'wx'});}
export function release(){if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}
export function save(topic:string,name:string,data:unknown){const dir=`${OUT}/${topic}`;mkdirSync(dir,{recursive:true});writeFileSync(`${dir}/${name}.json`,JSON.stringify(data,null,2)+'\n');}
export async function connect(max=1){const db=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});try{await assertDisposable(db);if(Number((await db.query('show port')).rows[0].port)!==56439)throw Error('Disposable port mismatch');return db;}catch(e){await db.end();throw e;}}
