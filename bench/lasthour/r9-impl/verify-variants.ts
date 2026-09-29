/** Pure-memory algebra check of the actual SQL parameter rewrite. No DB access. */
import {assert} from './common.js';
import {rewrite,candidateCount} from './variants.js';
const array=(x:any)=>Array.isArray(x)?x:String(x).slice(1,-1).split(',').filter(Boolean);
let checks=0;
for(const strings of [false,true])for(let n=0;n<=10;n++){
 const tokens=Array.from({length:n},(_,i)=>String(i+11)),proof=Buffer.from('unchanged-key'),original={text:'select "c"."tokens_abcd" @> $2::bigint[] and example_proof($3)',values:['scope',strings?`{${tokens.join(',')}}`:tokens,proof]};
 const before=JSON.stringify(original.values);
 for(const restCheck of [false,true]){
  const q=rewrite(original,restCheck);assert.equal(JSON.stringify(original.values),before);assert.equal(q.values[0],'scope');assert.equal(q.values[2],proof);assert(q.text.endsWith('and example_proof($3)'));
  const kept=array(q.values[1]);assert(kept.length<=3);const restIndex=q.text.match(/sealql_has_all"\("c"\."tokens_abcd",\$(\d+)::bigint\[\]\)/)?.[1],rest=restIndex?array(q.values[Number(restIndex)-1]):[];
  for(let mask=0;mask<2**n;mask++){const stored=new Set(tokens.filter((_,i)=>mask&(1<<i))),expected=tokens.every(t=>stored.has(t)),actual=kept.every(t=>stored.has(t))&&(!restCheck||rest.every(t=>stored.has(t)));if(restCheck)assert.equal(actual,expected);else if(expected)assert(actual);checks++;}
 }
}
const nested={text:'select count(*)::text as count from (select "__seal_idx"."row_id" from "test_lasthour_product"."customers_seal_index" as "__seal_idx" where "__seal_idx"."scope_id"=$1 and (("__seal_idx"."tokens_abcd" @> $2::bigint[] and "test_lasthour_product"."sealql_match_positions"($3,example_nested($4))) or (("__seal_idx"."tokens_ef01")[1]=$5::bigint and "__seal_idx"."eq_stamp_ef01"=((\'x\'||pg_catalog.encode(example_nested($6),\'hex\'))::bit(64)::bigint)))) as "__seal_matches"',values:['scope',['11','12','13','14'],Buffer.from('proof'),7,'9',Buffer.from('exact')]};
const stripped=candidateCount(rewrite(nested,true));assert(!/sealql_match_positions|eq_stamp|example_nested/.test(stripped.text));assert(stripped.text.includes('sealql_has_all'));assert(stripped.text.includes(' or '));assert.equal(stripped.values.length,4);assert(!stripped.values.some(Buffer.isBuffer));
console.log(`PASS: ${checks} candidate/rest truth-table checks; nested proof removal; input and proof parameters preserved`);
