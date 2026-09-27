// Mechanical known-plaintext attack (count/co-occurrence style, Cash et al. CCS'15 family) on a stolen token dump.
// Attacker knows the plaintext of k% of rows (e.g. rows they inserted themselves). For every token they compute the set of
// known rows containing it; for every piece in the known plaintexts the same set; a token is decoded when exactly one piece
// has an identical row set. Score: decoded share of all stored piece occurrences, and rows (not known) mostly decoded.
// Usage: node --import tsx bench/standard-review/known-row-attack.ts <ratings.txt>
import { readFileSync } from 'node:fs';
const lines=readFileSync(process.argv[2],'utf8').split('\n').slice(1).map(l=>l.split('\t')[1]).filter(s=>s&&s.trim().length>=2);
const norm=(s:string)=>s.normalize('NFC').replace(/\s+/g,'').replace(/[A-Z]/g,c=>c.toLowerCase());
const fnv=(s:string)=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;};
const pieces=(v:string,skip:boolean)=>{const a=Array.from(norm(v)),out=new Set<string>();for(let i=0;i+1<a.length;i++)out.add(a[i]+a[i+1]);if(skip)for(let i=0;i+2<a.length;i++)out.add(a[i]+'_'+a[i+2]);return [...out];};
const victim=lines.slice(0,100000);
let seed=99;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
function run(bits:number|null,skip:boolean,knownPct:number){
  const tokOf=(p:string)=>bits===null?p:String(fnv(p)%(2**bits));
  const known=new Set<number>();while(known.size<victim.length*knownPct/100)known.add(Math.floor(rnd()*victim.length));
  const tokSig=new Map<string,number[]>(),pieceSig=new Map<string,number[]>();
  victim.forEach((v,r)=>{for(const p of pieces(v,skip)){const t=tokOf(p);if(known.has(r)){(tokSig.get(t)??tokSig.set(t,[]).get(t)!).push(r);(pieceSig.get(p)??pieceSig.set(p,[]).get(p)!).push(r);}}});
  const bySig=new Map<string,string[]>();for(const [p,s] of pieceSig){const k=s.join(',');(bySig.get(k)??bySig.set(k,[]).get(k)!).push(p);}
  const decoded=new Map<string,string>();for(const [t,s] of tokSig){const c=bySig.get(s.join(','));if(c&&c.length===1)decoded.set(t,c[0]);}
  let ok=0,total=0,rowsMostly=0,unknownRows=0;
  victim.forEach((v,r)=>{const ps=pieces(v,skip);let good=0;for(const p of ps){total++;if(decoded.get(tokOf(p))===p){ok++;good++;}}if(!known.has(r)){unknownRows++;if(ps.length&&good/ps.length>=0.8)rowsMostly++;}});
  console.log(`| ${skip?'2글자+건너뛴':'2글자'} | ${bits===null?'절단 없음':bits+'비트'} | ${knownPct}% | ${(100*ok/total).toFixed(1)}% | ${(100*rowsMostly/unknownRows).toFixed(1)}% |`);
}
console.log('| 토큰 | 비트 | 공격자가 원문을 아는 행 | 해독된 조각(등장 기준) | 모르는 행 중 조각 80% 이상 해독된 행 |');
for(const pct of [1,5])for(const skip of [false,true])for(const bits of [16,17,20,null])run(bits,skip,pct);
