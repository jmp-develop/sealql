/** Memory-only adapter checks; mock query callback, no database imports or connections. */
import assert from 'node:assert/strict';
import {compileBShared,needsAppCheck,normalizedPredicate,runBShared} from './b-list300.js';
import {fields,type Node} from '../verify-native/r8-cases.js';
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const long:Node={field:'memo',op:'contains',value:'상세안내와확인내용'.repeat(5)};
assert(needsAppCheck(long));assert(needsAppCheck({field:'company',op:'eq',value:'서울서비스 담당'}));
assert(!needsAppCheck({field:'memo',op:'contains',value:'서비스'}));
const q=await compileBShared(long,{mode:'count'});
assert(q.text.includes('p.memo_ct memo'));assert(!q.text.includes('p.company_ct'));
assert(q.text.includes('LIMIT 300'));assert(!q.text.includes('count(*)'));
const mock=(data:{id:string;memo:string;company?:string}[])=>{
 const opened:string[]=[];
 const host={query:async(text:string,params:unknown[])=>{
  if(text.includes('p.id=ANY')){const ids=params[1] as string[];return {rows:data.filter(r=>ids.includes(r.id)).map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,Buffer.from(f==='memo'?r.memo:f==='company'?r.company??'없음':f)]))}))};}
  const cursor=text.includes('j.id>$2::uuid')?String(params[1]):'';
  const limit=Number(text.match(/LIMIT (\d+)/)![1]);
  return {rows:data.filter(r=>r.id>cursor).slice(0,limit).map(r=>({id:r.id,...Object.fromEntries(fields.filter(f=>text.includes('p.'+f+'_ct '+f)).map(f=>[f,Buffer.from(f==='memo'?r.memo:f==='company'?r.company??'없음':f)]))}))};
 },open:(field:any,ct:Buffer)=>{opened.push(field);return ct.toString('utf8');}};
 return {host,opened};
};
// Every fake DB candidate has the same 8-character windows, but insufficient repetitions.
const falsePositive=mock(Array.from({length:605},(_,i)=>({id:uuid(i+1),memo:'상세안내와확인내용'.repeat(2)})));
const count=await runBShared(long,{mode:'count'},falsePositive.host);
assert.equal(count.value,0);assert.equal(count.candidateRows,605);assert.equal(count.sqlCalls,3);
assert.equal(count.conditionDecrypts,605);assert.equal(count.projectionDecrypts,0);
assert(falsePositive.opened.every(f=>f==='memo'));
// First 300 DB candidates all fail; the list must continue beyond that batch.
const listData=Array.from({length:605},(_,i)=>({id:uuid(i+1),memo:i<305?'상세안내와확인내용'.repeat(2):long.value}));
const listMock=mock(listData),list=await runBShared(long,{mode:'list',limit:300,batch:300},listMock.host);
assert(Array.isArray(list.value));assert.equal(list.value.length,300);
assert.deepEqual(list.value.map(r=>r.id),listData.slice(305).map(r=>r.id));
assert.equal(list.candidateRows,605);assert.equal(list.conditionDecrypts,605);
assert.equal(list.projectionDecrypts,300*5);assert.equal(list.sqlCalls,4);assert.equal(list.appRows,905);
// An OR branch with a long false condition must not turn into AND during app checking.
const mixed:Node={any:[{field:'company',op:'eq',value:'성공'},long]};
const mixedMock=mock([{id:uuid(1),memo:'짧은메모',company:'성공'},{id:uuid(2),memo:'짧은메모',company:'실패'}]);
const mixedResult=await runBShared(mixed,{mode:'count'},mixedMock.host);
assert.equal(mixedResult.value,1);assert.equal(mixedResult.conditionDecrypts,3);
assert(normalizedPredicate({field:'memo',op:'contains',value:'서비스 상담'})(()=> '서비스상담'));
const short:Node={field:'memo',op:'contains',value:'서비스'};
const shortCount=await runBShared(short,{mode:'count'},{query:async(text)=>{assert(text.includes('count(*)'));return {rows:[{n:12}]};},open:()=>{throw Error('count should not decrypt');}});
assert.equal(shortCount.value,12);assert.equal(shortCount.appRows,1);assert.equal(shortCount.conditionDecrypts,0);
const shortList=await runBShared(short,{mode:'list',limit:300},mock(Array.from({length:400},(_,i)=>({id:uuid(i+1),memo:'서비스'}))).host);
assert(Array.isArray(shortList.value));assert.equal(shortList.value.length,300);assert.equal(shortList.sqlCalls,1);assert.equal(shortList.projectionDecrypts,1800);
console.log(JSON.stringify({databaseAccess:false,checks:['fallback field projection','605 long false positives rejected','list refills beyond first 300 candidates','condition plaintext reused for projection','OR and lazy unique-field decryption','normalized space semantics'],passed:true}));
