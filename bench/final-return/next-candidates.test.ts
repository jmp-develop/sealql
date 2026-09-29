import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../../src/index.js';
import {createSealed} from '../../src/adapters/drizzle/v0.45/index.js';
import {compileStampQuery,keyArray} from '../../src/core/stamp-query.js';
import {profiles} from '../../src/core/search-tokens.js';
import {positionProof,stamp,compactText} from '../../src/core/search-stamps.js';
import {firstOccurrenceVariant,toastTargetVariant} from './next-candidates.js';

// These tests deliberately import no DB driver and execute no SQL.
test('candidate generates arbitrary N with original binds and unchanged LIKE fallback',async()=>{
  const sealer = createSealer({key:new Uint8Array(32).fill(74)});
  const profile = profiles('candidate','body',{type:'text',search:{substring:true}})[0];
  const sizes: number[] = [];
  for (const length of [2,3,4,5,6,8,45]) {
    const proof = await compileStampQuery(sealer.ring('candidate'),profile,'s',{op:'contains',value:'가'.repeat(length)});
    const call = '"test_candidate"."sealql_match_positions"($1::bytea[],$2::integer[],$3,n,salt,stamps,positions,0)';
    const params = [keyArray(proof.keys),proof.offsets,proof.length];
    const transformed = firstOccurrenceVariant({text:'select '+call,params});
    assert.equal(transformed.params,params);
    assert.equal(transformed.text.match(/pg_catalog\.sha256\(/g)?.length,proof.keys.length);
    assert.equal(transformed.text.match(/then true else/g)?.length,1);
    assert.ok(transformed.text.endsWith(`else ${call} end)`));
    assert.ok(transformed.text.includes('offset 0'));
    if (length === 45) assert.equal(proof.keys.length,23);
    sizes.push(Buffer.byteLength(transformed.text));
    const twice = firstOccurrenceVariant({text:`select (${call} or ${call})`,params});
    assert.equal(twice.text.match(/then true else/g)?.length,2);
    const encoded = firstOccurrenceVariant({text:'select '+call,params:[params[0],`{${proof.offsets.join(',')}}`,params[2]]});
    assert.equal(encoded.text,transformed.text);
  }
  console.log(JSON.stringify({lengths:[2,3,4,5,6,8,45],candidateSqlBytes:sizes}));
  const like = {text:'select "test_candidate"."sealql_match_like"($1::bytea[],$2::integer[],n,salt,stamps,positions)',params:[]};
  assert.deepEqual(firstOccurrenceVariant(like),like);
});

test('first-occurrence sufficient proof has no extra matches in memory; repeated match needs fallback',async()=>{
  const ring = createSealer({key:new Uint8Array(32).fill(75)}).ring('candidate');
  const profile = profiles('candidate','body',{type:'text',search:{substring:true}})[0];
  const cases = [
    ['서울특별시세종대로','세종대로'],['서비스상담서비스','서비스상담'],
    ['푸른달','푸른달'],['서비스상담','없는조각'],['abxxabcd','abcd'],
    ['ab'.repeat(2000)+'ac','abac'],['ab'.repeat(2000)+'ac','abababzq'],
    ['a'.repeat(45),'a'.repeat(45)],['서비스상담','서비스상담추가'],['','서울'],
  ];
  let fallbackMatch = false;
  for (const [value,needle] of cases) {
    const stored = await positionProof(ring,profile,'s',value,'compact2');
    for (const op of ['contains','startsWith','endsWith'] as const) {
      const proof = await compileStampQuery(ring,profile,'s',{op,value:needle});
      const first = await Promise.all(proof.keys.map(async key => {
        const index = stored.stamps.indexOf(await stamp(key,stored.salt,1));
        return index < 0 ? null : stored.offsets[index];
      }));
      const p = first[0] === null ? null : first[0]-proof.offsets[0];
      const sufficient = p !== null && p >= 0 && p <= stored.length-proof.length &&
        (op !== 'startsWith' || p === 0) && (op !== 'endsWith' || p === stored.length-proof.length) &&
        first.every((position,i) => position !== null && position === p+proof.offsets[i]);
      const plain = compactText(value,profile), query = compactText(needle,profile);
      const expected = op === 'contains' ? plain.includes(query) : plain[op](query);
      if (sufficient) assert.equal(expected,true,`${value.length}/${needle}/${op}`);
      if (!sufficient && expected) fallbackMatch = true;
    }
  }
  assert.equal(fallbackMatch,true);
});

test('TOAST candidate appends only a table parameter on a new test schema',()=>{
  const sealed = createSealed({sealer:createSealer({key:new Uint8Array(32).fill(76)})});
  const table = pgSchema('test_candidate').table('rows',{id:uuid('id').primaryKey(),body:sealed.text('body',{search:{substring:true}})});
  const seal = sealed.register(table,{row:'id'});
  const before = sealed.extraMigrationSql(seal);
  const candidate = [...before,...toastTargetVariant(seal,4096)];
  assert.deepEqual(candidate.slice(0,-1),before);
  assert.equal(candidate.at(-1),'alter table "test_candidate"."rows_seal_index" set (toast_tuple_target=4096)');
  assert.ok(before.some(sql => sql.includes('set storage main')));
  assert.throws(()=>toastTargetVariant(seal,9000));
});
