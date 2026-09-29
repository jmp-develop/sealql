/** Count coarse candidates separately from final matches, outside timed runs. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {Pool} from 'pg';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../../src/index.js';
import {createSealed} from '../../src/adapters/drizzle/v0.45/index.js';
import {registrationOf} from '../../src/adapters/drizzle/v0.45/native.js';
import {profiles,searchPieces,searchTokens} from '../../src/core/search-tokens.js';
import {assertDisposable} from '../../test/disposable.js';
import {BASE_CASES} from './cases.js';
import {fields,plainWhere,type Node} from './r8-cases.js';
const S='test_r9_performance_main',scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
try{
 const cipher=createSealer({key:new Uint8Array(32).fill(93)}),sealed=createSealed({sealer:cipher}),cols:any={id:uuid('id').primaryKey(),scopeId:uuid('scope_id').notNull()};
 for(const f of fields)cols[f]=sealed.text(f,{search:{exact:f==='company'?{bits:2}:true,substring:{wordBoundary:true}}});
 const table=pgSchema(S).table('customers',cols),reg=registrationOf(sealed.register(table,{row:'id',scope:'scopeId'}));
 async function coarse(n:Node,params:unknown[]):Promise<string>{
  if('all'in n||'any'in n){const out=[];for(const c of 'all'in n?n.all:n.any)out.push(await coarse(c,params));return '('+out.join('all'in n?' AND ':' OR ')+')';}
  const p=profiles(reg.model,n.field,reg.definition.fields[n.field]).find(p=>p.mode===(n.op==='eq'?'exact':'substring'))!,column=reg.storage.index!.profiles![p.indexId].tokens;
  const tokens=await searchTokens(cipher.ring(reg.model),scope,p,searchPieces(p,n.value,n.op==='eq'?'write':n.op));params.push(p.mode==='exact'?tokens[0]:tokens);
  return p.mode==='exact'?`("${column}")[1]=$${params.length}::bigint`:`"${column}" @> $${params.length}::bigint[]`;
 }
 const rows=[];for(const name of ['exact_common','sub_common_memo','starts','ends','and2','and6','or2','sub45']){
  const node=BASE_CASES.find(c=>c.name===name)!.node,params:unknown[]=[scope],where=await coarse(node,params),pp:unknown[]=[scope],pw=plainWhere(node,pp);
  const candidates=(await pool.query(`select count(*)::int n from ${S}.customers_seal_index where scope_id=$1 and ${where}`,params)).rows[0].n;
  const matches=(await pool.query(`select count(*)::int n from research_u.customers_plain where scope_id=$1 and ${pw}`,pp)).rows[0].n;
  assert.ok(candidates>=matches);rows.push({name,candidates,matches,listRows:Math.min(300,matches),countRows:1});
 }
 writeFileSync('bench/results/2026-09-29-r9/candidates.json',JSON.stringify(rows,null,2));console.log(JSON.stringify(rows));
}finally{await pool.end();}
