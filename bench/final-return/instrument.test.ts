import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
test('SQL rewrite preserves rowMode and replaces separate config values',async()=>{
 const original=Client.prototype.query,forwarded:any[]=[];
 (Client.prototype as any).query=function(...args:any[]){forwarded.push(args);return Promise.resolve({rows:[[7,8]]});};
 try{
  const {measured}=await import('./instrument.js');
  const fake={processID:123};
  const out=await measured(()=>(Client.prototype.query as any).call(fake,{text:'select $1',rowMode:'array'},[6]),s=>{assert.deepEqual(s.values,[6]);return {text:'select $1,$2',values:[7,8]};});
  assert.equal(forwarded[0][0].rowMode,'array');assert.equal(forwarded[0][0].text,'select $1,$2');assert.deepEqual(forwarded[0][0].values,[7,8]);assert.deepEqual(forwarded[0][1],[7,8]);assert.deepEqual(out.queries,[{text:'select $1,$2',values:[7,8]}]);assert.deepEqual(out.pids,[123]);assert.equal(out.metric.appRows,1);
 }finally{Client.prototype.query=original;}
});
