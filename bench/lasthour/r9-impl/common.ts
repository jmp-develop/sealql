import {mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync,renameSync} from 'node:fs';
import {Pool} from 'pg';
import {assertDisposable} from '../../../test/disposable.js';
export {fields,scope,assert,normalize,type Node,type Case,median} from '../../final-return/common.js';
export const OUT='bench/results/2026-09-29-lasthour/r9-impl',schema='test_lasthour_product';
const lock='.local/research/measure.lock',owner=`lasthour-r9-impl ${process.pid}`;
export function acquire(){writeFileSync(lock,owner,{flag:'wx'});}
export function release(){if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}
export function save(name:string,data:unknown){
 mkdirSync(OUT,{recursive:true});const target=`${OUT}/${name}.json`,temporary=`${target}.${process.pid}.tmp`;
 writeFileSync(temporary,JSON.stringify(data,null,2)+'\n');
 // Readers always see a complete snapshot; Windows readers can briefly hold a replacement open.
 for(let attempt=0;;attempt++){try{renameSync(temporary,target);break;}catch(error){if(attempt===39)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}}
}
export async function connect(){const db=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',max:1,idleTimeoutMillis:0,options:'-c statement_timeout=120000'});try{await assertDisposable(db);if(Number((await db.query('show port')).rows[0].port)!==56439)throw Error('Disposable port mismatch');return db;}catch(e){await db.end();throw e;}}
