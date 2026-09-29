import {loadRows} from '../../attack-extra/common.js';
import {norm} from '../../attack-extra/codec.js';
import {writeFileSync} from 'node:fs';
const rows=await loadRows(),output:any={referenceRows:10000,victimRows:10000,seed:714029,fields:{}};
for(const field of ['memo','address','name'] as const){
 const rr=rows.map(r=>({b:Buffer.byteLength(r[field]),n:Array.from(norm(r[field])).length,s:(r[field].match(/ /g)??[]).length}));
 const ref=rr.slice(10000,20000),victim=rr.slice(0,10000),out:any={};
 for(const mode of ['bytes','bytesN','n','padded32N','padded64N','padded128N']){
  const q=Number(mode.match(/^padded(\d+)/)?.[1]??0),key=(r:any)=>mode==='n'?String(r.n):mode==='bytes'?String(r.b):[q?Math.ceil((r.b+4)/q)*q:r.b,r.n].join(',');
  const dict=new Map<string,Map<number,number>>();for(const r of ref){const k=key(r),v=dict.get(k)??new Map<number,number>();v.set(r.s,(v.get(r.s)??0)+1);dict.set(k,v);}
  let covered=0,unique=0,correct=0,rangeCorrect=0,maxWidth=0,sumWidth=0,mostFrequentCorrect=0;
  for(const r of victim){const v=dict.get(key(r));if(!v)continue;covered++;const a=[...v.keys()].sort((a,b)=>a-b),w=a.at(-1)!-a[0]+1;sumWidth+=w;maxWidth=Math.max(maxWidth,w);rangeCorrect+=Number(a[0]<=r.s&&r.s<=a.at(-1)!);if(v.size===1){unique++;correct+=Number(a[0]===r.s);}mostFrequentCorrect+=Number([...v].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0][0]===r.s);}
  out[mode]={covered,unique,correct,rangeCorrect,maxWidth,meanWidth:sumWidth/covered,mostFrequentCorrect};
 }
 output.fields[field]=out;
}
writeFileSync('bench/results/2026-09-29-independent-review/space-reference-length.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
