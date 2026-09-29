import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadRows,scope} from '../../attack-extra/common.js';
import {Codec,norm,ring} from '../../attack-extra/codec.js';
import {historical,sourceHash} from '../../attack-extra/historical.js';
const rows=await loadRows();
assert.equal(rows.length,100000);
const fields=['memo','address','name'] as const;
const output:any={fixture:'bench_realistic_100k.customers',rows:rows.length,seed:714029,identityDigest:createHash('sha256').update(JSON.stringify(rows.map(r=>r.id))).digest('hex'),cipherOverheadBytes:29,historicalSourceHash:sourceHash,readOnly:true,formulas:{minOldN:'ceil((substringTokenCount + 1) / 2), for n>=2; adjacent+skip+start+end at most 2n-1 tokens',genericOld:'s in [0,b-minOldN] (normalization-width stable, ASCII spaces, nonspace widths 1..4)',genericNew:'s in [max(0,b-4n),b-n]',hangulNew:'s=b-3n; valid only if all nonspaces are 3-byte characters',referenceAttack:'10,000 disjoint reference rows -> 10,000 victims; old signature b,t; new b,t,n; unique reference space count is a prediction, not a guarantee'},fields:{}};
const summary=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b);return {min:a[0],median:a[Math.floor(a.length/2)],max:a.at(-1),mean:a.reduce((s,v)=>s+v,0)/a.length};};
for(const field of fields){
 const codec=new Codec(field,'pre-r9'),records:any[]=[],counts:any={rows:0,spaceOnlyWhitespace:0,normalizationWidthStable:0,pureHangulAndSpace:0,threeByteAndSpace:0,asciiAndSpace:0,naiveHangulFormulaCorrect:0,naiveHangulFormulaNonnegative:0,oldGenericExact:0,newGenericExact:0,newRangeTighter:0,oldIncludesTruth:0,newIncludesTruth:0,asciiSuffix5AndHangul:0,asciiSuffix5FormulaCorrect:0},hist:any={spaces:{},byteWidths:{},oldBounds:{},newBounds:{}};
 const oldWidths:number[]=[],newWidths:number[]=[],oldNs:number[]=[],ns:number[]=[],pureOldWidths:number[]=[];
 const suffixSubset={rows:0,oldExact:0,newExact:0,oldPossibleCountSum:0,oldMaxPossibleCount:0};
 const signatureHistogram:Record<string,number>={};
 for(let i=0;i<rows.length;i++){
  const raw=rows[i][field];assert.equal(typeof raw,'string');const compact=norm(raw),chars=Array.from(compact),n=chars.length,b=Buffer.byteLength(raw),s=(raw.match(/ /g)??[]).length,t=codec.tokens(raw).length;
  const onlySpaces=raw.replaceAll(' ','')===raw.replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g,''),stable=Buffer.byteLength(compact)===b-s && Array.from(raw.replaceAll(' ','')).length===n;
  assert.ok(n>=2);assert.ok(t<=2*n-1);const loN=Math.ceil((t+1)/2),oldLo=0,oldHi=b-loN,newLo=Math.max(0,b-4*n),newHi=b-n;
  counts.rows++;counts.spaceOnlyWhitespace+=Number(onlySpaces);counts.normalizationWidthStable+=Number(stable);assert.ok(onlySpaces&&stable);
  counts.oldIncludesTruth+=Number(oldLo<=s&&s<=oldHi);counts.newIncludesTruth+=Number(newLo<=s&&s<=newHi);assert.ok(oldLo<=s&&s<=oldHi&&newLo<=s&&s<=newHi);
  counts.oldGenericExact+=Number(oldLo===oldHi);counts.newGenericExact+=Number(newLo===newHi);counts.newRangeTighter+=Number(newHi-newLo<oldHi-oldLo);
  oldWidths.push(oldHi-oldLo+1);newWidths.push(newHi-newLo+1);oldNs.push(loN);ns.push(n);
  const pureHangul=/^[가-힣 ]+$/.test(raw),three=chars.every(c=>Buffer.byteLength(c)===3),ascii=chars.every(c=>Buffer.byteLength(c)===1),formula=b-3*n;
  counts.pureHangulAndSpace+=Number(pureHangul);counts.threeByteAndSpace+=Number(three);counts.asciiAndSpace+=Number(ascii);counts.naiveHangulFormulaCorrect+=Number(formula===s);counts.naiveHangulFormulaNonnegative+=Number(formula>=0);
  if(three){assert.equal(formula,s);pureOldWidths.push(Math.floor(b/3)-loN+1);}
  const suffix=/^[가-힣 ]+ [a-z0-9]{5}$/.test(raw);counts.asciiSuffix5AndHangul+=Number(suffix);counts.asciiSuffix5FormulaCorrect+=Number(suffix&&b-3*n+10===s);if(suffix)assert.equal(b-3*n+10,s);
  hist.spaces[s]=(hist.spaces[s]??0)+1;const w=[1,2,3,4].map(k=>chars.filter(c=>Buffer.byteLength(c)===k).length).join(',');hist.byteWidths[w]=(hist.byteWidths[w]??0)+1;
  for(const [key,l,h]of [['oldBounds',oldLo,oldHi],['newBounds',newLo,newHi]] as const){const q=l+':'+h;hist[key][q]=(hist[key][q]??0)+1;}
  if(suffix){const lo=Math.max(6,loN),hi=Math.floor((b+10)/3),poss=hi-lo+1;assert.ok(lo<=n&&n<=hi);suffixSubset.rows++;suffixSubset.oldExact+=Number(poss===1);suffixSubset.newExact++;suffixSubset.oldPossibleCountSum+=poss;suffixSubset.oldMaxPossibleCount=Math.max(suffixSubset.oldMaxPossibleCount,poss);}
  const sig=[b,t,n,s].join(',');signatureHistogram[sig]=(signatureHistogram[sig]??0)+1;
  records.push({b,t,n,s});
  if(i<20){const p=historical.profiles('customers',field,{type:'text',search:{substring:true}})[0];assert.deepEqual(codec.tokens(raw),await historical.searchTokens(ring,scope,p,historical.searchPieces(p,raw)));}
 }
 const ref=records.slice(10000,20000),victim=records.slice(0,10000),predict:any={};
 for(const mode of ['bytes','bytesTokens','bytesTokensN','tokensN','padded32TokensN','padded64TokensN','padded128TokensN']){
  const q=Number(mode.match(/^padded(\d+)/)?.[1]??0);
  const key=(r:any)=>mode==='tokensN'?[r.t,r.n].join(','):q?[Math.ceil((r.b+4)/q)*q,r.t,r.n].join(','):[r.b,...(mode==='bytes'?[]:[r.t]),...(mode==='bytesTokensN'?[r.n]:[])].join(','),dict=new Map<string,Set<number>>();
  for(const r of ref){const k=key(r),v=dict.get(k)??new Set<number>();v.add(r.s);dict.set(k,v);}
  let covered=0,unique=0,uniqueCorrect=0,ambiguous=0,rangeIncludes=0,totalRangeWidth=0,maxRangeWidth=0,majorityCorrect=0;
  for(const r of victim){const v=dict.get(key(r));if(!v)continue;covered++;const a=[...v].sort((x,y)=>x-y);if(a.length===1){unique++;uniqueCorrect+=Number(a[0]===r.s);}else ambiguous++;rangeIncludes+=Number(a[0]<=r.s&&r.s<=a.at(-1)!);const width=a.at(-1)!-a[0]+1;totalRangeWidth+=width;maxRangeWidth=Math.max(maxRangeWidth,width);}
  predict[mode]={referenceRows:ref.length,victimRows:victim.length,covered,uniquePredictionRows:unique,uniqueCorrectRows:uniqueCorrect,uniqueWrongRows:unique-uniqueCorrect,ambiguousRows:ambiguous,missingRows:victim.length-covered,rangeIncludesTruthRows:rangeIncludes,meanCoveredRangeWidth:totalRangeWidth/covered,maxRangeWidth};
 }
 const padding:any={};for(const q of [32,64,128]){const overheads=records.map(r=>Math.ceil((r.b+4)/q)*q-r.b),before=records.reduce((s,r)=>s+r.b+29,0);padding[q]={innerLengthBytes:4,currentCipherBytes:before,paddedCipherBytes:before+overheads.reduce((s,v)=>s+v,0),extraBytes:summary(overheads),ratio:(before+overheads.reduce((s,v)=>s+v,0))/before,strongAttackerPossibleSpaceCounts:summary(records.map(r=>{const p=Math.ceil((r.b+4)/q)*q,lo=Math.max(0,p-q-3),hi=p-4,nonspaceBytes=r.b-r.s;return hi-Math.max(lo,nonspaceBytes)+1;}))};}
 output.fields[field]={counts,actualSpaces:hist.spaces,algebra:{oldPossibleSpaceCounts:summary(oldWidths),newPossibleSpaceCounts:summary(newWidths),oldMinN:summary(oldNs),actualN:summary(ns),threeByteSubsetOldPossibleSpaceCounts:pureOldWidths.length?summary(pureOldWidths):null,hangulPlusFiveAsciiSubset:suffixSubset},referencePrediction:predict,padding,histograms:hist,signatureHistogram,validation:{historicalWebCryptoRows:20,coverageAssertions:records.length}};
 console.log(field,JSON.stringify(output.fields[field]));
}
writeFileSync('bench/results/2026-09-29-independent-review/space-leakage.json',JSON.stringify(output,null,2)+'\n');
