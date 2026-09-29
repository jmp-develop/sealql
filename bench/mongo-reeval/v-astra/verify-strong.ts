/** Independently checks the unique-occurrence dictionary reduction and shape witnesses. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {rows,fields,norm,publicRowShape,type Options} from '../models.js';
const ROOT='bench/results/2026-09-30-mongo-reeval',all=rows(),victims=all.slice(0,10000),reference=all.slice(10000,20000),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const raw=readFileSync(ROOT+'/m1-astra/strong-dictionary.json','utf8'),input=JSON.parse(raw),out:any={complete:false,sourceHash:hash(raw),aggregateChecks:0,predictionsRescored:0,certificateRows:0,certificateValues:0,errors:[]};
function pieces(v:string,field:string,port:boolean){const cs=Array.from(norm(v)),s=new Set<string>(port?['e\0'+norm(v)]:[]);for(let i=0;i<cs.length;i++)for(let n=2;n<=10&&i+n<=cs.length;n++)s.add('s\0'+cs.slice(i,i+n).join(''));if(port&&['address','email'].includes(field))for(let n=2;n<=10&&n<=cs.length;n++){s.add('p\0'+cs.slice(0,n).join(''));s.add('x\0'+cs.slice(-n).join(''));}if(!port){const real=s.size;s.add('e\0'+norm(v));if(publicRowShape({id:'C-mongo',field,mode:'partial',maxLength:60},v).tagCount>real+1)s.add('pad\0'+norm(v));}return [...s];}
try{
 if(!process.argv.includes('--partial'))assert.equal(input.complete,true);out.partial=!input.complete;
 for(const r of input.results){const f=r.field as typeof fields[number],port=r.model==='C-port',o:Options={id:r.model,field:f,mode:port?'combined':'partial',maxLength:60},known=victims.slice(0,r.known).map(v=>v[f]).filter(v=>publicRowShape(o,v).supported),owner=new Map<string,number>();
  known.forEach((v,i)=>{for(const p of pieces(v,f,port)){const old=owner.get(p);owner.set(p,old===undefined?i:old===i?i:-1);}});const alone=new Map<number,string[]>();for(const [p,i]of owner)if(i>=0){const a=alone.get(i)??[];a.push(p);alone.set(i,a);}const learned=new Set([...alone.values()].filter(a=>a.length===1).map(a=>a[0]));assert.equal(learned.size,r.learnedLabels);
  const freq=new Map<string,number>();for(const v of reference.map(v=>v[f]).filter(v=>publicRowShape(o,v).supported).map(norm))freq.set(v,(freq.get(v)??0)+1);const prior=[...freq.keys()].sort((a,b)=>freq.get(b)!-freq.get(a)!);const guess=prior.find(v=>!pieces(v,f,port).some(p=>learned.has(p)))??prior[0];assert.equal(guess,r.value);
  const truth=victims.flatMap((v,i)=>i>=r.known&&publicRowShape(o,v[f]).supported?[norm(v[f])]:[]),correct=truth.filter(v=>v===guess).length;assert.equal(r.correct,correct);assert.equal(r.rows,truth.length);assert.equal(r.pct,100*correct/truth.length);assert.equal(r.predictionDigest,hash(JSON.stringify(truth.map(()=>guess))));out.aggregateChecks++;out.predictionsRescored+=truth.length;
 }
 const audit=JSON.parse(readFileSync(ROOT+'/m1-astra/audit.json','utf8'));
 for(const c of audit.phoneCertificates){const o:Options={id:c.model,field:'phone',mode:c.model==='C-port'?'combined':'partial',maxLength:60},shape=(v:string)=>{const s=publicRowShape(o,v);return JSON.stringify([s.tagCount,s.cipherBytes]);};let covered=0;
  for(const cl of c.classes){const refs=new Set(reference.map(v=>norm(v.phone)).filter(v=>shape(v)===cl.shape));assert.equal(cl.referenceDistinct,refs.size);const n=victims.filter(v=>shape(v.phone)===cl.shape).length;assert.equal(n,cl.rows);assert.equal(new Set(cl.witnesses).size,cl.witnesses.length);for(const w of cl.witnesses){assert.ok(refs.has(w));assert.equal(shape(w),cl.shape);out.certificateValues++;}if(refs.size>=2)covered+=n;}
  assert.equal(covered,c.rowsWithAtLeastTwoReferenceWitnesses);out.certificateRows+=covered;
 }
 out.complete=true;
}catch(e){out.errors.push(String(e));throw e;}finally{writeFileSync(ROOT+'/v-astra/verify-strong.json',JSON.stringify(out,null,2)+'\n');}
console.log(JSON.stringify(out));
