// Mechanical frequency attack (Naveed et al. CCS'15 style) on a stolen token dump — no keys, no AI.
// Attacker: sees each token and how many rows contain it; owns public Korean text of the same kind (disjoint half);
// maps tokens to pieces by frequency rank. Score = share of stored token occurrences whose piece is guessed right.
// Usage: node --import tsx bench/standard-review/frequency-attack.ts <ratings.txt>
import { readFileSync } from 'node:fs';
const lines=readFileSync(process.argv[2],'utf8').split('\n').slice(1).map(l=>l.split('\t')[1]).filter(s=>s&&s.trim().length>=2);
const norm=(s:string)=>s.normalize('NFC').replace(/\s+/g,'').replace(/[A-Z]/g,c=>c.toLowerCase());
const fnv=(s:string)=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;};
const pieces=(v:string,skip:boolean)=>{const a=Array.from(norm(v)),out=new Set<string>();for(let i=0;i+1<a.length;i++)out.add(a[i]+a[i+1]);if(skip)for(let i=0;i+2<a.length;i++)out.add(a[i]+'_'+a[i+2]);return out;};
const victim=lines.slice(0,100000),reference=lines.slice(100000,200000);
function run(bits:number|null,skip:boolean){
  const tokOf=(p:string)=>bits===null?p:String(fnv(p)%(2**bits));
  const tokRows=new Map<string,number>(),tokTruth=new Map<string,Map<string,number>>();
  for(const v of victim)for(const p of pieces(v,skip)){const t=tokOf(p);tokRows.set(t,(tokRows.get(t)??0)+1);const m=tokTruth.get(t)??new Map();m.set(p,(m.get(p)??0)+1);tokTruth.set(t,m);}
  const refFreq=new Map<string,number>();for(const v of reference)for(const p of pieces(v,skip))refFreq.set(p,(refFreq.get(p)??0)+1);
  const tokRank=[...tokRows].sort((a,b)=>b[1]-a[1]).map(x=>x[0]),refRank=[...refFreq].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
  let hit=0,total=0,topHit=0;tokRank.forEach((t,i)=>{const guess=refRank[i];const truth=tokTruth.get(t)!;const n=[...truth.values()].reduce((a,b)=>a+b,0);total+=n;hit+=truth.get(guess)??0;if(i<100&&(truth.get(guess)??0)>0)topHit++;});
  // row-level: rows where attacker guesses >=80% of their piece occurrences correctly
  const right=new Map<string,string>();tokRank.forEach((t,i)=>right.set(t,refRank[i]));
  let rowsMostly=0;for(const v of victim){const ps=[...pieces(v,skip)];const ok=ps.filter(p=>right.get(tokOf(p))===p).length;if(ps.length&&ok/ps.length>=0.8)rowsMostly++;}
  console.log(`| ${skip?'2글자+건너뛴 조각':'2글자 조각'} | ${bits===null?'절단 없음':bits+'비트'} | ${(100*hit/total).toFixed(1)}% | ${topHit}/100 | ${(100*rowsMostly/victim.length).toFixed(1)}% |`);
}
console.log('| 토큰 | 비트 | 맞힌 조각 비율(등장 기준) | 상위 100개 토큰 중 맞힘 | 조각의 80% 이상을 맞힌 행 |');
for(const skip of [false,true])for(const bits of [16,17,20,null])run(bits,skip);
