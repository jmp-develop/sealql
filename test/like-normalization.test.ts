import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pgSchema,uuid} from 'drizzle-orm/pg-core';
import {createSealer} from '../src/index.js';
import {createSealed} from '../src/adapters/drizzle/v0.45/index.js';
import {registrationOf} from '../src/adapters/drizzle/v0.45/native.js';
import {compileSearch} from '../src/core/search-predicate.js';
import {profiles} from '../src/core/search-tokens.js';
import {compileStampQuery,normalizeLike} from '../src/core/stamp-query.js';
import {candidateRows} from '../src/core/candidate-sql.js';

test('single-literal LIKE compiles to equivalent positional SQL without an exact profile',async()=>{
  const cipher=createSealer({key:new Uint8Array(32).fill(72)}),sealed=createSealed({sealer:cipher});
  const table=pgSchema('test_like_compile').table('rows',{id:uuid('id').primaryKey(),body:sealed.text('body',{search:{substring:true}})});
  const seal=sealed.register(table,{row:'id'}),reg=registrationOf(seal),stored=profiles(reg.model,'body',reg.definition.fields.body),ring=cipher.ring(reg.model);
  for(const [pattern,op,value] of [['%est','endsWith','est'],['%%est%%','contains','est'],['est%%','startsWith','est'],['%a\\%b%','contains','a%b'],['%a\\_b%','contains','a_b']] as const){
    const a=await compileSearch({field:'body',op:'like',value:pattern},reg.definition,stored,ring,'s');
    const b=await compileSearch({field:'body',op,value},reg.definition,stored,ring,'s');
    assert.deepEqual(candidateRows(reg.storage,'s',a),candidateRows(reg.storage,'s',b));
  }
  const exact=await compileStampQuery(ring,stored[0],'s',{op:'like',value:' EST '});
  assert.equal(exact.whole,true);assert.equal(exact.affix,1);assert.equal(exact.pattern,undefined);
  assert.equal(normalizeLike('%te%st',stored[0]),undefined);
  assert.equal(normalizeLike('%te__',stored[0]),undefined);
  for(const pattern of ['%te%st','%te__'])assert.ok((await compileStampQuery(ring,stored[0],'s',{op:'like',value:pattern})).pattern);
  await assert.rejects(compileStampQuery(ring,stored[0],'s',{op:'like',value:'%a%'}),/QUERY_TOO_BROAD/);
});
