// Real Korean text (NSMC) — follow-up: skip-bigrams for middle fragments, 1-char autocomplete, bits vs leakage, storage, query token pruning.
// Usage: node --import tsx bench/standard-review/corpus-sim3.ts <ratings.txt> [short|long]
import { readFileSync, writeFileSync } from 'node:fs';
const lines=readFileSync(process.argv[2],'utf8').split('\n').slice(1).map(l=>l.split('\t')[1]).filter(s=>s&&s.trim().length>=2);
const KIND=(process.argv[3]??'long') as 'short'|'long',N=KIND==='long'?100000:200000;
let seed=0x7654321;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
const keep=(s:string)=>s.normalize('NFC').replace(/\s+/g,' ').trim().replace(/[A-Z]/g,c=>c.toLowerCase());
const norm=(s:string)=>keep(s).replace(/ /g,'');
const fnv=(s:string)=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;};
const grams=(a:string[],gap:number)=>a.length<gap+2?[]:Array.from({length:a.length-gap-1},(_,i)=>a[i]+(gap?'_':'')+a[i+gap+1]);
const edges=(v:string)=>keep(v).split(' ').filter(Boolean).flatMap(w=>{const a=Array.from(w);return ['<'+a[0],a[a.length-1]+'>'];});
interface Opt{bits:number|null;skip:boolean;uni:boolean}
const name=(o:Opt)=>`기준${o.skip?'+건너뛴조각':''}${o.uni?'+1글자':''} ${o.bits===null?'무절단':o.bits+'비트'}`;
const tok=(o:Opt)=>(x:string)=>o.bits===null?x:'h'+(fnv(x)%(2**o.bits));
function index(v:string,o:Opt){const a=['^',...Array.from(norm(v)),'$'];const t=[...grams(a,0),...edges(v)];if(o.skip)t.push(...grams(a,1));if(o.uni)t.push(...Array.from(norm(v)));return [...new Set(t.map(tok(o)))];}
function query(q:string,op:string,o:Opt,limit?:number){const ws=keep(q).split(' '),a=[...(op==='prefix'?['^']:[]),...Array.from(norm(q))];
  if(a.length===1||(op==='prefix'&&a.length===2&&!o.uni&&false))return [...new Set([a[0]].map(tok(o)))];
  let t=grams(a,0);if(o.skip)t.push(...grams(a,1));
  ws.forEach((w,i)=>{const c=Array.from(w);if(i>0)t.push('<'+c[0]);if(i<ws.length-1)t.push(c[c.length-1]+'>');});
  t=[...new Set(t)];if(limit&&t.length>limit){const step=t.length/limit;t=Array.from({length:limit},(_,i)=>t[Math.floor(i*step)]);} // evenly spread subset
  return t.map(tok(o));}
function build(rows:string[],o:Opt){const ids=new Map<string,number>();const rt:Int32Array[]=[];let total=0;
  for(const v of rows){const r=Int32Array.from(index(v,o).map(k=>{let i=ids.get(k);if(i===undefined){i=ids.size;ids.set(k,i);}return i;}));rt.push(r);total+=r.length;}
  const cnt=new Int32Array(ids.size);for(const r of rt)for(const t of r)cnt[t]++;
  const off=new Int32Array(ids.size+1);for(let i=0;i<ids.size;i++)off[i+1]=off[i]+cnt[i];
  const post=new Int32Array(off[ids.size]),pos=off.slice(0,ids.size);rt.forEach((r,ri)=>{for(const t of r)post[pos[t]++]=ri;});
  let rare=0;for(const r of rt)if(r.some(t=>cnt[t]<=5))rare++;
  return {ids,off,post,cnt,rarePct:+(100*rare/rows.length).toFixed(1),tokensPerRow:+(total/rows.length).toFixed(1)};}
function cands(ix:ReturnType<typeof build>,toks:string[]){const ts=toks.map(k=>ix.ids.get(k));if(ts.some(t=>t===undefined))return {rows:[] as number[],work:0};
  const s=(ts as number[]).sort((a,b)=>ix.cnt[a]-ix.cnt[b]);const work=s.reduce((w,t)=>w+ix.cnt[t],0);
  let cur=Array.from(ix.post.subarray(ix.off[s[0]],ix.off[s[0]+1]));for(const t of s.slice(1)){const set=new Set(ix.post.subarray(ix.off[t],ix.off[t+1]));cur=cur.filter(x=>set.has(x));if(!cur.length)break;}return {rows:cur,work};}
const rows:string[]=[];for(let i=0;i<N;i++){if(KIND==='short')rows.push(lines[i%lines.length]);else{let s='';while(s.length<230)s+=(s?' ':'')+lines[Math.floor(rnd()*lines.length)];rows.push(s.slice(0,250));}}
const keepRows=rows.map(keep),normRows=rows.map(norm);
const qs:{kind:string;q:string;op:string;limit?:number}[]=[];
for(let k=0;k<250;k++){const v=rows[Math.floor(rnd()*N)],w=keep(v).split(' ').filter(Boolean),a=Array.from(norm(v));
  qs.push({kind:'필드 시작 1글자',q:a[0],op:'prefix'});qs.push({kind:'어디든 1글자',q:a[Math.floor(rnd()*a.length)],op:'contains'});
  for(const n of [3,5])if(a.length>n+2){const o=Math.floor(rnd()*(a.length-n));qs.push({kind:`중간 조각 ${n}글자`,q:a.slice(o,o+n).join(''),op:'contains'});}
  if(w.length>=2){const i=Math.floor(rnd()*(w.length-1));qs.push({kind:'두 단어',q:`${w[i]} ${w[i+1]}`,op:'contains'});}
  if(w.length>=5){const i=Math.floor(rnd()*(w.length-4));const q=w.slice(i,i+5).join(' ');qs.push({kind:'긴 구절 5단어 (토큰 전부)',q,op:'contains'});qs.push({kind:'긴 구절 5단어 (토큰 8개만)',q,op:'contains',limit:8});}}
const opts:Opt[]=[{bits:16,skip:false,uni:false},{bits:16,skip:true,uni:false},{bits:17,skip:true,uni:false},{bits:16,skip:false,uni:true},{bits:20,skip:false,uni:false},{bits:24,skip:false,uni:false},{bits:32,skip:false,uni:false},{bits:null,skip:false,uni:false}];
const out:any={kind:KIND,rows:N,schemes:{}};
for(const o of opts){const ix=build(rows,o);const by:any={};
  for(const x of qs){const unsupported=Array.from(norm(x.q)).length<2&&!(x.op==='prefix')&&!o.uni;if(unsupported){(by[x.kind]??={q:0,exact:0,cand:0,truth:0,work:0,na:true});continue;}
    const {rows:c,work}=cands(ix,query(x.q,x.op,o,x.limit));const kq=keep(x.q),nq=norm(x.q);
    const truth=c.filter(r=>x.op==='prefix'?normRows[r].startsWith(nq):kq.includes(' ')?keepRows[r].includes(kq):normRows[r].includes(nq)).length;
    const g=(by[x.kind]??={q:0,exact:0,cand:0,truth:0,work:0});g.q++;if(c.length===truth)g.exact++;g.cand+=c.length;g.truth+=truth;g.work+=work;}
  out.schemes[name(o)]={tokensPerRow:ix.tokensPerRow,rarePct:ix.rarePct,by};console.error('done',name(o));}
const S=Object.keys(out.schemes);
console.log(`\n### ${KIND==='long'?'긴 메모(≈250자)':'짧은 메모'} ${N.toLocaleString()}행 — 칸: 정확 비율 · 후보÷정답`);
console.log(`| 검색 형태 | ${S.join(' | ')} |`);
for(const k of Object.keys(out.schemes[S[0]].by))console.log(`| ${k} | ${S.map(s=>{const g=out.schemes[s].by[k];return g.na?'미지원':`${(100*g.exact/g.q).toFixed(0)}% · ×${(g.cand/Math.max(1,g.truth)).toFixed(2)}`;}).join(' | ')} |`);
console.log(`| 긴 구절 DB 작업량(토큰 전부 → 8개) | ${S.map(s=>{const a=out.schemes[s].by['긴 구절 5단어 (토큰 전부)'],b=out.schemes[s].by['긴 구절 5단어 (토큰 8개만)'];return a&&b?`${Math.round(a.work/a.q)} → ${Math.round(b.work/b.q)}`:'-';}).join(' | ')} |`);
console.log(`| 행당 토큰 수 | ${S.map(s=>out.schemes[s].tokensPerRow).join(' | ')} |`);
console.log(`| 누출: 희귀 토큰(≤5행) 보유 행 | ${S.map(s=>out.schemes[s].rarePct+'%').join(' | ')} |`);
writeFileSync(`bench/results/standard-review-2026-09-26/corpus-sim3-${KIND}.json`,JSON.stringify(out,null,1));
