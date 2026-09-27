// Real Korean text (NSMC reviews) — token scheme comparison incl. word-boundary anchors, AWS-formula bits, leakage proxy.
// Usage: node --import tsx bench/standard-review/corpus-sim2.ts <ratings.txt>
import { readFileSync, writeFileSync } from 'node:fs';
const lines=readFileSync(process.argv[2],'utf8').split('\n').slice(1).map(l=>l.split('\t')[1]).filter(s=>s&&s.trim().length>=2);
let seed=0x1234567;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
const keep=(s:string)=>s.normalize('NFC').replace(/\s+/g,' ').trim().replace(/[A-Z]/g,c=>c.toLowerCase());
const norm=(s:string)=>keep(s).replace(/ /g,'');
const fnv=(s:string)=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;};
const bi=(a:string[])=>a.length<2?[]:Array.from({length:a.length-1},(_,i)=>a[i]+a[i+1]);
type Scheme={name:string;index:(v:string)=>string[];query:(q:string,op:string)=>string[]};
const T=(bits:number|null)=>(x:string)=>bits===null?x:'h'+(fnv(x)%(2**bits));
const wordEdges=(v:string)=>keep(v).split(' ').filter(Boolean).flatMap(w=>{const a=Array.from(w);return ['<'+a[0],a[a.length-1]+'>'];});
function scheme(label:string,bits:number|null,anchors:boolean,words:boolean):Scheme{const t=T(bits);return{name:`${label} (${bits===null?'절단 없음':bits+'비트'})`,
  index:v=>[...new Set([...bi(anchors?['^',...Array.from(norm(v)),'$']:Array.from(norm(v))),...(words?wordEdges(v):[])].map(t))],
  query:(q,op)=>{const ws=keep(q).split(' ');const extra:string[]=[];if(words)ws.forEach((w,i)=>{const a=Array.from(w);if(i>0)extra.push('<'+a[0]);if(i<ws.length-1)extra.push(a[a.length-1]+'>');});
    return [...new Set([...bi([...(anchors&&op==='prefix'?['^']:[]),...Array.from(norm(q))]),...extra].map(t))];}};}
function build(rows:string[],s:Scheme){const ids=new Map<string,number>();const rowToks:Int32Array[]=[];
  for(const v of rows)rowToks.push(Int32Array.from(s.index(v).map(k=>{let i=ids.get(k);if(i===undefined){i=ids.size;ids.set(k,i);}return i;})));
  const cnt=new Int32Array(ids.size);for(const r of rowToks)for(const t of r)cnt[t]++;
  const off=new Int32Array(ids.size+1);for(let i=0;i<ids.size;i++)off[i+1]=off[i]+cnt[i];
  const post=new Int32Array(off[ids.size]),pos=off.slice(0,ids.size);rowToks.forEach((r,ri)=>{for(const t of r)post[pos[t]++]=ri;});
  let rare=0;for(const r of rowToks)if(r.some(t=>cnt[t]<=5))rare++;
  return {ids,off,post,cnt,rarePct:+(100*rare/rows.length).toFixed(1)};}
function cands(ix:ReturnType<typeof build>,toks:string[]):number[]{const ts=toks.map(k=>ix.ids.get(k));if(ts.some(t=>t===undefined))return [];
  const sorted=(ts as number[]).sort((a,b)=>ix.cnt[a]-ix.cnt[b]);let cur=Array.from(ix.post.subarray(ix.off[sorted[0]],ix.off[sorted[0]+1]));
  for(const t of sorted.slice(1)){const set=new Set(ix.post.subarray(ix.off[t],ix.off[t+1]));cur=cur.filter(x=>set.has(x));if(!cur.length)break;}return cur;}
function corpus(kind:'short'|'long',n:number){const out:string[]=[];for(let i=0;i<n;i++){if(kind==='short')out.push(lines[i%lines.length]);else{let s='';while(s.length<230)s+=(s?' ':'')+lines[Math.floor(rnd()*lines.length)];out.push(s.slice(0,250));}}return out;}
function queries(rows:string[]){const qs:{kind:string;q:string;op:string}[]=[];const pick=()=>rows[Math.floor(rnd()*rows.length)];
  for(let k=0;k<200;k++){const v=pick(),w=keep(v).split(' ').filter(Boolean),a=Array.from(norm(v));
    for(const n of [2,3,4,6])if(a.length>=n)qs.push({kind:`필드 시작 자동완성 ${n}글자`,q:a.slice(0,n).join(''),op:'prefix'});
    const wi=Math.floor(rnd()*w.length);if(Array.from(w[wi]).length>=2)qs.push({kind:'단어 하나',q:w[wi],op:'contains'});
    if(w.length>=2){const i=Math.floor(rnd()*(w.length-1));qs.push({kind:'두 단어 (띄어쓰기 포함)',q:`${w[i]} ${w[i+1]}`,op:'contains'});qs.push({kind:'두 단어 (띄어쓰기 없이)',q:`${w[i]}${w[i+1]}`,op:'contains'});}
    for(const n of [3,5])if(a.length>n+2){const o=Math.floor(rnd()*(a.length-n));qs.push({kind:`중간 조각 ${n}글자`,q:a.slice(o,o+n).join(''),op:'contains'});}
    if(w.length>=4){const i=Math.floor(rnd()*(w.length-3));qs.push({kind:'긴 구절 (4단어)',q:w.slice(i,i+4).join(' '),op:'contains'});}
    const m=a.slice(0,Math.min(a.length,4));if(m.length>=3){m[1]=String.fromCharCode(0xac00+Math.floor(rnd()*11172));qs.push({kind:'없는 값',q:m.join(''),op:'contains'});}}
  return qs;}
const report:any={};
for(const [kind,n] of [['short',200000],['long',100000]] as const){
  const rows=corpus(kind,n),keepRows=rows.map(keep),normRows=rows.map(norm),qs=queries(rows);
  const P=new Set(normRows.flatMap(v=>bi(Array.from(v)))).size,aws=Math.round(Math.log2(P)-1);
  const schemes=[scheme('현재: 2글자',16,false,false),scheme('2글자',null,false,false),scheme('2글자+시작/끝',16,true,false),scheme('2글자+시작/끝+단어경계',16,true,true),scheme('2글자+시작/끝+단어경계',aws,true,true),scheme('2글자+시작/끝+단어경계',null,true,true)];
  const key=`${kind==='short'?'짧은 메모(리뷰 1문장)':'긴 메모(≈250자)'} ${n.toLocaleString()}행`;
  const R:any={avgChars:Math.round(normRows.reduce((s,v)=>s+v.length,0)/n),distinctBigrams:P,awsBits:aws,schemes:{}};report[key]=R;
  for(const s of schemes){const ix=build(rows,s);const by:any={};
    for(const x of qs){const c=cands(ix,s.query(x.q,x.op)),kq=keep(x.q),nq=norm(x.q);
      const truth=c.filter(r=>x.op==='prefix'?normRows[r].startsWith(nq):(kq.includes(' ')?keepRows[r].includes(kq)||normRows[r].includes(nq)&&!kq.includes(' '):normRows[r].includes(nq))).length;
      const g=(by[x.kind]??={q:0,exact:0,cand:0,truth:0});g.q++;if(c.length===truth)g.exact++;g.cand+=c.length;g.truth+=truth;}
    R.schemes[s.name]={distinctTokens:ix.cnt.length,rareRowsPct:ix.rarePct,by};console.error('done',key,s.name);}
  console.log(`\n### ${key}: 평균 ${R.avgChars}자, 서로 다른 2글자 조각 ${P.toLocaleString()}개 (16비트 칸당 ${(P/65536).toFixed(1)}), AWS 공식 비트 ${aws}`);
  console.log(`| 검색 형태 | ${schemes.map(s=>s.name).join(' | ')} |`);
  for(const k of Object.keys(R.schemes[schemes[0].name].by))console.log(`| ${k} | ${schemes.map(s=>{const g=R.schemes[s.name].by[k];return `${(100*g.exact/g.q).toFixed(0)}% · ×${(g.cand/Math.max(1,g.truth)).toFixed(2)}`;}).join(' | ')} |`);
  console.log(`| 누출: 희귀 토큰(≤5행) 보유 행 | ${schemes.map(s=>R.schemes[s.name].rareRowsPct+'%').join(' | ')} |`);
}
writeFileSync('bench/results/standard-review-2026-09-26/corpus-sim2.json',JSON.stringify(report,null,1));
