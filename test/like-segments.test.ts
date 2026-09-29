import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {assertDisposable} from './disposable.js';
import {profiles,compactText} from '../src/core/search-tokens.js';
import {positionProof} from '../src/core/search-stamps.js';
import {compileStampQuery,keyArray,parseLike,patternProgram} from '../src/core/stamp-query.js';
import {stampMigrationSql} from '../src/core/stamp-sql.js';

test('LIKE segment order matches PostgreSQL LIKE for overlaps, escapes, underscores, empty and long values',async()=>{
  const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=45000'});
  const schema=`test_like_segments_${process.pid}`;let created=false;
  try{
    await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
    assert.equal((await pool.query('select 1 from pg_namespace where nspname=$1',[schema])).rowCount,0);
    await pool.query(`create schema ${schema}`);created=true;
    for(const sql of stampMigrationSql(schema))await pool.query(sql);
    const ring={keyScopeId:'global',key:new Uint8Array(32).fill(73)};
    const profile=profiles('like','body',{type:'text',search:{substring:true}})[0];
    const patterns=['%aba%ba%','%ab%ab%','ab%ba','%ab_ba%','_ab%','%ab__','__%ab','%ab_%ba%',
      '%__%ab%_%','%ab%_%ba','ab__%','%ab%__','%ab\\%ba%','%ab\\_ba%','%ab\\\\ba%',
      '%ababac_%','%ababab%ac','%ababab%zz','ab','ab%','%ab','%ab%',
      '%ab\\%ba%ba%','%ab\\_ba_%','%ab\\\\ba%ba','%_ab%__%ba%','%가나_다라%','%ab％cd%'];
    const prepared=await Promise.all(patterns.map(async pattern=>({pattern,proof:await compileStampQuery(ring,profile,'s',{op:'like',value:pattern}),
      plain:parseLike(pattern,profile).map(p=>typeof p==='string'?p:p.text.replace(/[\\%_]/g,c=>'\\'+c)).join('')})));
    const values:(string|null)[]=[null,'','ab%ba','ab_ba','ab\\ba','ab%bababa','ab_baba','ab\\bababa','가나😀다라','ab%cd','ab'.repeat(2000)+'ac'];
    for(let n=1;n<=6;n++)for(let bits=0;bits<2**n;bits++)values.push(Array.from({length:n},(_,i)=>bits&(1<<i)?'a':'b').join(''));
    let comparisons=0;
    // Values are ephemeral parameters only: no generated records are loaded.
    for(const value of values){
      const stored=value===null?null:await positionProof(ring,profile,'s',value,'compact2');
      for(const {pattern,plain,proof}of prepared){
        const common=[stored?.length??null,stored?.salt??null,stored?.stamps.map(String)??null,stored?.offsets??null,value===null?null:compactText(value,profile),plain];
        const call=proof.pattern?`${schema}.sealql_match_like($1::bytea[],$2::integer[],$3::integer,$4::bytea,$5::bigint[],$6::integer[])`:
          `(${proof.whole?'$3::integer=$9::integer and ':''}${schema}.sealql_match_positions($1::bytea[],$2::integer[],$9::integer,$3::integer,$4::bytea,$5::bigint[],$6::integer[],$10::integer))`;
        const params=[keyArray(proof.keys),proof.pattern?patternProgram(proof.pattern):proof.offsets,...common,...(proof.pattern?[]:[proof.length,proof.affix])];
        const row=(await pool.query(`select ${call} actual,$7::text like $8::text expected`,params)).rows[0];
        assert.equal(row.actual,row.expected,`${value?.length??'null'}:${pattern}`);comparisons++;
      }
    }
    console.log(JSON.stringify({likeSegmentComparisons:comparisons,longValueLength:4002,dbRowsInserted:0}));
  }finally{if(created)await pool.query(`drop schema ${schema} cascade`);await pool.end();}
});
