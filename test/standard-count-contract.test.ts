import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pgTable,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../src/index.js';
import {createSealed} from '../src/adapters/drizzle/v0.45/index.js';

test('scalar count rejects unsafe integers, removed budgets, and cancellation without decryption',async()=>{
  const cipher=createSealer({key:new Uint8Array(32)}),sealed=createSealed({sealer:cipher});
  cipher.open=async()=>{throw Error('count must not decrypt');};
  const table=pgTable('count_contract',{id:uuid('id').primaryKey(),body:sealed.text('body')}),seal=sealed.register(table,{row:'id'});
  let value='9007199254740991',queries=0;
  const db={select:()=>({from:()=>({where:async()=>{queries++;return [{count:value}];}})})} as any;
  assert.equal(await sealed.count(db,seal,{}),Number.MAX_SAFE_INTEGER);
  value='9007199254740992';await assert.rejects(sealed.count(db,seal,{}),{code:'LIMIT_EXCEEDED'});
  value='-1';await assert.rejects(sealed.count(db,seal,{}),{code:'INVALID_CANDIDATE_SHAPE'});
  const before=queries;
  await assert.rejects(sealed.count(db,seal,{budgets:{batch:10}} as never),{code:'INVALID_VALUE'});
  await assert.rejects(sealed.count(db,seal,{maxCandidates:10} as never),{code:'INVALID_VALUE'});
  await assert.rejects(sealed.count(db,seal,{signal:AbortSignal.abort()}),{code:'CANCELLED'});
  assert.equal(queries,before);
});
