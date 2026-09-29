import {mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync,renameSync} from 'node:fs';
export {fields,scope,assert,normalize,type Node,type Case,median,connect,condition} from '../../final-return/common.js';
export const OUT='bench/results/2026-09-30-p1-verify/v-astra';
const lock='.local/research/measure.lock',owner=`p1-verify-v-astra ${process.pid}`;
export function acquire(){writeFileSync(lock,owner,{flag:'wx'});}
export function release(){if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}
export function save(name:string,data:unknown){mkdirSync(OUT,{recursive:true});const target=`${OUT}/${name}.json`,temp=`${target}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(data,null,2)+'\n');for(let i=0;;i++){try{renameSync(temp,target);break;}catch(e){if(i===39)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}}}
