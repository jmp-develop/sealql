/** Independent whole-population shape-prediction replay and witness rescoring. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {rows,fields,norm,type Options} from '../models.js';
const ROOT='bench/results/2026-09-30-mongo-reeval',OUT=ROOT+'/v-astra';mkdirSync(OUT,{recursive:true});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),data=rows(),victim=data.slice(0,10000),reference=data.slice(10000,20000);
const shapes=new Map<string,{tags:number;bytes:number;supported:boolean}>();
function shape(o:Options,v:string){const key=JSON.stringify([o,v]);let s=shapes.get(key);if(!s){s=calculateShape(o,v);shapes.set(key,s);}return s;}
function calculateShape(o:Options,v:string){v=norm(v);const chars=Array.from(v);if(o.id==='C-mongo'){const E=(Math.floor((Buffer.byteLength(v)+5)/16)+1)*16,P=Math.min(o.maxLength??60,E-5);let n=1;for(let start=0;start<P;start++)for(let end=start+2;end<=P&&end<=start+10;end++)n++;return {tags:o.mode==='eq'?1:n,bytes:E,supported:o.mode==='eq'||chars.length<=(o.maxLength??60)};}
 const tags=new Set(['e\0'+v]);for(let start=0;start<chars.length;start++)for(let n=2;n<=10&&start+n<=chars.length;n++)tags.add('s\0'+chars.slice(start,start+n).join(''));if(o.field==='address'||o.field==='email')for(let n=2;n<=10&&n<=chars.length;n++){tags.add('p\0'+chars.slice(0,n).join(''));tags.add('x\0'+chars.slice(-n).join(''));}return {tags:tags.size,bytes:Buffer.byteLength(v)+28,supported:true};
}
function predictors(o:Options,ref:string[],known:string[],includeBytes=true){
 const counts=new Map<string,number>(),kc=new Map<string,number>();for(const v of ref)counts.set(v,(counts.get(v)??0)+1);for(const v of known)kc.set(v,(kc.get(v)??0)+1);
 const key=(v:string)=>{const s=shape(o,v);return JSON.stringify([s.tags,includeBytes?s.bytes:null]);},groups=new Map<string,Set<string>>();for(const v of [...counts.keys(),...kc.keys()]){const k=key(v),set=groups.get(k)??new Set();set.add(v);groups.set(k,set);}
 const best=(xs:string[],knownFlag:boolean)=>xs.sort((a,b)=>(counts.get(b)??0)+(knownFlag?(kc.get(b)??0):0)-(counts.get(a)??0)-(knownFlag?(kc.get(a)??0):0)||a.localeCompare(b))[0]??'';
 const prior=best([...counts.keys()],false),plain=new Map<string,string>(),post=new Map<string,string>();for(const [k,s]of groups){plain.set(k,best([...s],false));post.set(k,best([...s],true));}return (v:string,learned:boolean)=>(learned?post:plain).get(key(v))??prior;
}
const result:any={complete:false,started:new Date().toISOString(),files:[],shapePredictionsRescored:0,witnessesRescored:0,metricChecks:0,errors:[],limitations:'Index-only family aggregate metrics are arithmetic-checked and witnesses rescored, not independently replayed for every index prediction; full replay covers native_shape methods.'};
try{
 const names=readdirSync(ROOT+'/m1-astra').filter(x=>x.startsWith('ab-')&&x.endsWith('.json'));if(!process.argv.includes('--partial'))assert.equal(names.length,12,'All six fields and two models required');result.partial=names.length!==12;
 for(const file of names){const raw=readFileSync(ROOT+'/m1-astra/'+file,'utf8'),x=JSON.parse(raw);assert.equal(x.complete,true);assert.equal(x.identityDigest,hash(JSON.stringify(data.slice(0,20000).map(r=>r.id))));const field=x.field as typeof fields[number],options=x.options as Options,truth=victim.map(r=>r[field]),ref=reference.map(r=>r[field]).filter(v=>shape(options,v).supported),unsupported=truth.flatMap((v,i)=>shape(options,v).supported?[]:[i]);assert.deepEqual(x.unsupported.map((u:any)=>u.index),unsupported);
  const pred=new Map<number,ReturnType<typeof predictors>>(),tagsOnly=new Map<number,ReturnType<typeof predictors>>();for(const known of [0,100,500]){const k=truth.slice(0,known).filter(v=>shape(options,v).supported);pred.set(known,predictors(options,ref,k));tagsOnly.set(known,predictors(options,ref,k,false));}
  for(const r of x.results){const indices=truth.flatMap((v,i)=>i>=r.known&&shape(options,v).supported?[i]:[]);assert.equal(r.rows,indices.length);assert.equal(r.sharedKnownTargetRows,0);assert.equal(r.pct,100*r.correct/r.rows);assert.equal(r.characterPct,100*r.characters/r.totalCharacters);result.metricChecks+=4;
   for(const w of r.witnesses){assert.equal(w.id,victim[w.index].id);assert.equal(w.correct,norm(w.predicted)===norm(truth[w.index]));assert.ok(indices.includes(w.index));result.witnessesRescored++;}
   if(r.channel==='native_shape'||r.method.startsWith('public_tagcount_')){const guesses=indices.map(i=>(r.channel==='native_shape'?pred:tagsOnly).get(r.known)!(truth[i],r.method.endsWith('_known')));let correct=0,characters=0,totalCharacters=0,mostly=0;guesses.forEach((v,j)=>{const t=Array.from(norm(truth[indices[j]])),g=Array.from(norm(v)),hits=t.filter((c,i)=>g[i]===c).length;correct+=Number(t.join('')===g.join(''));characters+=hits;totalCharacters+=t.length;mostly+=Number(hits>=.8*t.length);});assert.equal(hash(JSON.stringify(guesses)),r.predictionDigest);for(const [k,n]of Object.entries({correct,characters,totalCharacters,mostly}))assert.equal(r[k],n);result.shapePredictionsRescored+=guesses.length;}
  }
  assert.equal(x.uniqueness.crossRowRepeats,0);assert.equal(x.uniqueness.distinctTags,x.uniqueness.tagOccurrences);if(x.model==='C-mongo')assert.equal(x.esc.plaintextCounters,0);
  result.files.push({file,sha256:hash(raw),conditions:x.results.length,unsupported:unsupported.length});
 }
 result.complete=true;
}catch(e){result.errors.push(String(e));throw e;}finally{result.finished=new Date().toISOString();writeFileSync(OUT+'/verify-ab.json',JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({complete:result.complete,files:result.files.length,shapePredictionsRescored:result.shapePredictionsRescored,witnessesRescored:result.witnessesRescored,metricChecks:result.metricChecks}));
