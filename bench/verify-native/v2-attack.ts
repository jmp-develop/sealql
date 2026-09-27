/** Read-only V2 token-dump attack using the native companion and public core APIs. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { profiles, searchPieces, searchTokens } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { fields, scopeId } from './schema.js';
import { cipher as sealer, fieldProfiles, tokenColumn } from './tokens.js';

const out = 'bench/results/2026-09-27-native-verification/v2';
const seed = 99, n = 20_000;
const pool = new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
const hex=(bytes:Uint8Array)=>Buffer.from(bytes).toString('hex');
const cache = { profiles: new Map<string, Promise<CryptoKey>>() };
type Row = { pieces: string[]; tokens: string[] };
const kindCache = new Map<string, {kind:string; value:string}>();
function decode(label: string) {
  let p = kindCache.get(label); if (p) return p;
  const b = Buffer.from(label, 'hex'), k = b.readUInt32BE(4);
  const kind = b.subarray(8, 8+k).toString(), v = b.readUInt32BE(8+k);
  p = {kind, value:b.subarray(12+k,12+k+v).toString()}; kindCache.set(label,p); return p;
}
function pieces(profile: ReturnType<typeof profiles>[number], value: string) { return searchPieces(profile,value).map(hex); }
function pct(a:number,b:number) { return b ? +(100*a/b).toFixed(2) : 0; }
function shuffle(nRows:number) {
  let x=seed; const a=Array.from({length:nRows},(_,i)=>i);
  for(let i=nRows-1;i>0;i--){x^=x<<13;x^=x>>>17;x^=x<<5;const j=Math.floor((x>>>0)/4294967296*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a;
}
function score(rows:Row[],oracle:Map<string,string>,guess:Map<string,string>,known:Set<number>) {
  const byKind:Record<string,{correct:number;total:number}>={};let mostly=0,unknown=0;
  rows.forEach((row,i)=>{let correct=0;for(const label of row.pieces){const k=decode(label).kind,b=byKind[k]??={correct:0,total:0};b.total++;if(guess.get(oracle.get(label)!)===label){b.correct++;correct++;}}if(!known.has(i)){unknown++;if(row.pieces.length&&correct/row.pieces.length>=.8)mostly++;}});
  const all=Object.values(byKind);return {byKind:Object.fromEntries(Object.entries(byKind).map(([k,v])=>[k,{...v,pct:pct(v.correct,v.total)}])),allPct:pct(all.reduce((a,b)=>a+b.correct,0),all.reduce((a,b)=>a+b.total,0)),unknown80Pct:pct(mostly,unknown),unknownRows:unknown};
}
function knownAttack(rows:Row[],known:Set<number>){
  const tokenSig=new Map<string,number[]>(),pieceSig=new Map<string,number[]>();
  rows.forEach((r,i)=>{if(!known.has(i))return;for(const t of r.tokens)(tokenSig.get(t)??tokenSig.set(t,[]).get(t)!).push(i);for(const p of r.pieces)(pieceSig.get(p)??pieceSig.set(p,[]).get(p)!).push(i);});
  const sigPieces=new Map<string,string[]>();for(const [p,ids] of pieceSig){const sig=ids.join(',');(sigPieces.get(sig)??sigPieces.set(sig,[]).get(sig)!).push(p);}
  const guesses=new Map<string,string>(),candidates=new Map<string,string[]>();for(const [t,ids] of tokenSig){const p=sigPieces.get(ids.join(','))??[];candidates.set(t,p);if(p.length===1)guesses.set(t,p[0]);}return {guesses,candidates};
}
function propagate(rows:Row[],initial:Map<string,string>,candidates:Map<string,string[]>) {
  const guess=new Map(initial),rounds:number[]=[];
  for(let round=0;round<6;round++){
    const votes=new Map<string,Map<string,number>>();
    for(const row of rows){
      const decoded=row.tokens.map(t=>guess.get(t)).filter((x):x is string=>!!x).map(decode);
      const adj=decoded.filter(x=>x.kind==='adjacent').map(x=>Array.from(x.value));
      const skip=decoded.filter(x=>x.kind==='skip').map(x=>Array.from(x.value));
      const implied=new Set<string>();
      for(const ab of adj)for(const bc of adj)if(ab[1]===bc[0])implied.add(`skip:${ab[0]}${bc[1]}`);
      for(const ac of skip)for(const ab of adj)if(ac[0]===ab[0])implied.add(`adjacent:${ab[1]}${ac[1]}`);
      for(const ac of skip)for(const bc of adj)if(ac[1]===bc[1])implied.add(`adjacent:${ac[0]}${bc[0]}`);
      if(!implied.size)continue;
      for(const t of row.tokens){if(guess.has(t))continue;for(const label of candidates.get(t)??[]){const p=decode(label);if(!implied.has(`${p.kind}:${p.value}`))continue;const v=votes.get(t)??new Map<string,number>();v.set(label,(v.get(label)??0)+1);votes.set(t,v);}}
    }
    let added=0;for(const [t,v] of votes){const ranked=[...v].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));if(ranked[0][1]>=2&&ranked[0][1]>=(ranked[1]?.[1]??0)+2){guess.set(t,ranked[0][0]);added++;}}rounds.push(added);if(!added)break;
  }return {guess,rounds};
}
async function oracleFor(labels:Set<string>,profile:ReturnType<typeof profiles>[number],ring:ReturnType<typeof sealer.ring>,attackScope:string){
  const oracle=new Map<string,string>(),list=[...labels];for(let i=0;i<list.length;i+=256){await Promise.all(list.slice(i,i+256).map(async p=>oracle.set(p,(await searchTokens(ring,attackScope,profile,[Buffer.from(p,'hex')],cache))[0])));}return oracle;
}
async function attack(name:string,victim:string[],reference:string[],profile:ReturnType<typeof profiles>[number],ring:ReturnType<typeof sealer.ring>,attackScope:string,dump?:string[][]){
  const victimPieces=victim.map(v=>pieces(profile,v)),referencePieces=reference.map(v=>pieces(profile,v));
  const labels=new Set(victimPieces.flat()),oracle=await oracleFor(labels,profile,ring,attackScope);
  const rows:Row[]=victimPieces.map((p,i)=>({pieces:p,tokens:dump?.[i]??[...new Set(p.map(x=>oracle.get(x)!))]}));
  let missing=0,extra=0;for(let i=0;i<rows.length;i++){const expected=new Set(victimPieces[i].map(x=>oracle.get(x)!)),actual=new Set(rows[i].tokens);for(const t of expected)if(!actual.has(t))missing++;for(const t of actual)if(!expected.has(t))extra++;}
  const tf=new Map<string,number>(),pf=new Map<string,number>();for(const row of rows)for(const t of row.tokens)tf.set(t,(tf.get(t)??0)+1);for(const p of referencePieces)for(const label of p)pf.set(label,(pf.get(label)??0)+1);
  const tr=[...tf].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])),pr=[...pf].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  const frequency=score(rows,oracle,new Map(tr.map(([t],i)=>[t,pr[i]?.[0]]).filter((x):x is [string,string]=>!!x[1])),new Set());
  const order=shuffle(rows.length),known=[1,5,10].map(k=>{const knownRows=new Set(order.slice(0,rows.length*k/100)),a=knownAttack(rows,knownRows),c=propagate(rows,a.guesses,a.candidates);return {knownPct:k,knownRows:knownRows.size,count:score(rows,oracle,a.guesses,knownRows),consistency:score(rows,oracle,c.guess,knownRows),rounds:c.rounds,addedGuesses:c.guess.size-a.guesses.size};});
  return {name,victimRows:rows.length,referenceRows:reference.length,uniquePieces:labels.size,uniqueTokens:tf.size,missing,extra,frequency,known};
}
const ratings=process.argv[2];if(!ratings)throw new Error('Pass .local/ratings.txt');
const reviews=readFileSync(ratings,'utf8').split('\n').slice(1).map(s=>s.split('\t')[1]).filter((s):s is string=>!!s&&Array.from(s).length>=2);
assert(reviews.length>=2*n);mkdirSync(out,{recursive:true});
const memoryProfile=profiles('review','text',{type:'text',search:{substring:true}})[0];
const memory=await attack('public-review-memory',reviews.slice(0,n),reviews.slice(n,2*n),memoryProfile,{key:new Uint8Array(32).fill(93),keyScopeId:'global'},'_');
console.error('Public review attack complete');
try{
  await assertDisposable(pool);
  assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_verify_main.customers')).rows[0].n),100000);
  assert.equal(Number((await pool.query("select count(*) n from native_verify_main.attack_customers where scope_id='_'" )).rows[0].n),40000);
  const memoProfile=fieldProfiles('attack_customers','memo').find(p=>p.mode==='substring')!;
  const memoCol=tokenColumn(memoProfile.indexId);
  const data=(await pool.query(`select p.memo_plain, i."${memoCol}" memo_tokens
    from bench_realistic_100k.customers p join native_verify_main.attack_customers_seal_index i
    on i.scope_id='_' and i.row_id=p.id where p.scope_id=$1 order by p.id limit $2`,[scopeId,2*n])).rows;
  assert.equal(data.length,2*n);
  const db=await attack('native-constant-scope-memo-token-dump',data.slice(0,n).map(r=>r.memo_plain),
    data.slice(n).map(r=>r.memo_plain),memoProfile,sealer.ring('attack_customers'),'_',data.slice(0,n).map(r=>r.memo_tokens.map(String)));
  console.error('Native DB memo attack complete');
  const short:any={};
  for(const field of ['phone','email','name'] as const){
    const exact=fieldProfiles('customers',field).find(p=>p.mode==='exact')!;
    const col=tokenColumn(exact.indexId);
    const rows=(await pool.query(`select p.${field}_plain value,octet_length(c.${field}_ct) cipher_bytes,
      (i."${col}")[1] exact_token from bench_realistic_100k.customers p
      join native_verify_main.customers c on c.scope_id=p.scope_id and c.id=p.id
      join native_verify_main.customers_seal_index i on i.scope_id=p.scope_id and i.row_id=p.id
      where p.scope_id=$1 order by p.id limit $2`,[scopeId,n])).rows;
    assert.equal(rows.length,n);
    const order=shuffle(n),known=[1,5,10].map(k=>{
      const ids=new Set(order.slice(0,n*k/100)),map=new Map<string,Set<string>>();
      rows.forEach((r,i)=>{if(!ids.has(i))return;const key=`${r.cipher_bytes}|${r.exact_token}`;
        (map.get(key)??map.set(key,new Set()).get(key)!).add(String(r.value));});
      let recovered=0,correct=0;
      rows.forEach((r,i)=>{if(ids.has(i))return;const words=map.get(`${r.cipher_bytes}|${r.exact_token}`);
        if(words?.size===1){recovered++;if(words.has(String(r.value)))correct++;}});
      return {knownPct:k,knownRows:ids.size,recovered,correct,correctPct:pct(correct,n-ids.size)};
    });
    const lengths=new Set(rows.map(r=>Number(r.cipher_bytes)));
    const overheads=[...new Set(rows.map(r=>Number(r.cipher_bytes)-Buffer.byteLength(String(r.value),'utf8')))];
    const tokens=new Set(rows.map(r=>String(r.exact_token)));
    short[field]={rows:n,cipherLengthBuckets:lengths.size,distinctValues:new Set(rows.map(r=>String(r.value))).size,
      distinctTokens:tokens.size,cipherOverheads:overheads,known};
  }
  const gin=(await pool.query(`select indexname,indexdef from pg_indexes where schemaname='native_verify_main'
    and tablename='customers_seal_index' and indexdef ilike '%using gin%'`)).rows;
  assert.equal(gin.length,1);assert.equal((gin[0].indexdef.match(/tokens_[a-f0-9]{16}/g)??[]).length,6);
  const result={conditions:{seed,victimRows:n,referenceRows:n,reviewSource:ratings,dbHost:'127.0.0.1',dbPort:56439,
    dbSource:'bench_realistic_100k',dbSchema:'native_verify_main',scopeId:'_',
    profile:'adjacent+start/end+skip; word boundary off for review, on for fixture'},
    memory,db,gin,short};
  writeFileSync(`${out}/attack.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({memory:{frequency:memory.frequency.allPct,known:memory.known.map(x=>[x.knownPct,x.count.allPct,x.consistency.allPct])},
    db:{frequency:db.frequency.allPct,known:db.known.map(x=>[x.knownPct,x.count.allPct,x.consistency.allPct]),missing:db.missing,extra:db.extra},
    short:Object.fromEntries(Object.entries(short).map(([k,v]:any)=>[k,{known:v.known.map((x:any)=>[x.knownPct,x.correctPct]),overheads:v.cipherOverheads}]))}));
}finally{await pool.end();}
