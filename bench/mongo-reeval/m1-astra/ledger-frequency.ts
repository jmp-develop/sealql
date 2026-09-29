import {readFileSync,writeFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import * as m from '../models.js';
const root='bench/results/2026-09-30-mongo-reeval/m1-astra',data=m.rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000);
/** Receives anonymous counter counts and public reference-piece frequencies only. */
function attack(observed:{id:string;n:number}[],referenceCounts:Map<string,number>){
 const rankedReference=[...referenceCounts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 const rankedObserved=[...observed].sort((a,b)=>b.n-a.n||a.id.localeCompare(b.id));
 const byCount=new Map<number,string[]>();for(const [p,n]of referenceCounts){const ps=byCount.get(n)??[];ps.push(p);byCount.set(n,ps);}
 return {rank:rankedObserved.map((x,i)=>({id:x.id,guess:rankedReference[i]?.[0],n:x.n})),uniqueExactCount:rankedObserved.flatMap(x=>{const ps=byCount.get(x.n);return ps?.length===1?[{id:x.id,guess:ps[0],n:x.n}]:[]})};
}
const results=[];
for(const field of m.fields){const counts=(rows:typeof data)=>{const out=new Map<string,number>();for(const r of rows)for(const p of m.publicPieces(field,r[field],'combined'))out.set(p,(out.get(p)??0)+1);return out;};
 const actual=counts(victim),referenceCounts=counts(reference),truth=new Map<string,string>();
 const observed=[...actual].map(([p,n])=>{const id=m.portEscId(m.portToken(field,p));truth.set(id,p);return {id,n};}).sort((a,b)=>a.id.localeCompare(b.id));
 const existing=JSON.parse(readFileSync(`${root}/ab-C-port-${field}.json`,'utf8'));m.assert.equal(hash('sha256',JSON.stringify(observed)),existing.esc.preDigest,'Projected counter snapshot differs from actually generated encoder');
 const prediction=attack(observed,referenceCounts),metric=(xs:{id:string;guess:string|undefined;n:number}[])=>({attempted:xs.length,correct:xs.filter(x=>x.guess===truth.get(x.id)).length,topExamples:xs.slice(0,8).map(x=>({...x,correct:x.guess===truth.get(x.id)}))});
 results.push({field,model:'C-port',counterRows:observed.length,rankAll:metric(prediction.rank),rankTop100:metric(prediction.rank.slice(0,100)),uniqueExactCount:metric(prediction.uniqueExactCount),counterToVictimRowLinksProvided:0});
}
writeFileSync(`${root}/ledger-frequency.json`,JSON.stringify({complete:true,databaseAccess:false,modelHash:hash('sha256',readFileSync('bench/mongo-reeval/models.ts')),meaning:'Anonymous counter-label prediction, not row plaintext recovery. C-mongo encrypted counters are not given to this attacker.',results},null,2)+'\n');console.log(JSON.stringify(results.map(x=>({field:x.field,top100:x.rankTop100.correct,unique:[x.uniqueExactCount.correct,x.uniqueExactCount.attempted]}))));
