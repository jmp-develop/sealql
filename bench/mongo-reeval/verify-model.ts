import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {hash} from 'node:crypto';
import {createOccurrenceModel,publicRowShape,queryHits,rows,fields,norm,assert,type Options} from './models.js';
const all=rows(),checks:any[]=[];
for(const field of fields)for(const id of ['C-port','C-mongo'] as const)for(const mode of id==='C-port'?['combined'] as const:['eq','partial'] as const){
 const options:Options={id,field,mode},encoder=createOccurrenceModel(options),values=all.slice(0,24).map(r=>norm(r[field]));
 values.forEach((v,i)=>encoder.insert('v'+i,v));encoder.insert('repeat',values[0]);
 const before=encoder.snapshot(),after=encoder.snapshot(true);let queryChecks=0;
 for(const v of values.slice(0,8))for(const op of ['eq','contains'] as const){const value=op==='eq'?v:Array.from(v).slice(0,3).join(''),q=encoder.query(value,op);if(q.unsupported)continue;
  const truth=[...values,values[0]].flatMap((v,i)=>(op==='eq'?v===value:v.includes(value))?[i]:[]);
  assert.deepEqual(queryHits(q,before),truth);assert.deepEqual(queryHits(q,after),truth);queryChecks+=2;
 }
 assert.deepEqual(before.rows,after.rows);assert.equal(before.rows.length,25);
 const first=new Set(before.rows[0].tags);assert.equal(before.rows.at(-1)!.tags.filter(t=>first.has(t)).length,0);
 for(let i=0;i<values.length;i++){const s=publicRowShape(options,values[i]);assert.equal(before.rows[i].tagCount,s.tagCount);assert.equal(before.rows[i].cipherBytes,s.cipherBytes);}
 if(id==='C-mongo'){assert.ok(before.esc.every(e=>e.n===undefined&&e.value!==undefined));assert.ok(after.esc.length<=before.esc.length);assert.equal(after.metadata.ecocRows,0);}
 encoder.update('v0',values[1]);encoder.remove('repeat');const changed=encoder.snapshot();
 const q=encoder.query(Array.from(values[1]).slice(0,3).join(''),'contains');if(!q.unsupported){const hits=queryHits(q,changed).map(i=>changed.rows[i].id).sort();const expected=values.flatMap((v,i)=>(i===0?values[1]:v).includes(Array.from(values[1]).slice(0,3).join(''))?['v'+i]:[]).sort();assert.deepEqual(hits,expected);queryChecks++;}
 assert.equal(changed.rows.length,24);checks.push({field,id,mode,queryChecks,beforeEsc:before.esc.length,afterEsc:after.esc.length,tagCount:before.rows[0].tagCount});
}
const long=all.find(r=>Array.from(norm(r.memo)).length>60)!.memo,options:Options={id:'C-mongo',field:'memo',mode:'partial'};
assert.equal(publicRowShape(options,long).supported,false);assert.equal(createOccurrenceModel(options).insert('unsupported',long).supported,false);
const result={pass:true,databaseAccess:false,cases:checks.length,checks,unsupportedPreserved:true,sourceHash:hash('sha256',readFileSync('bench/mongo-reeval/models.ts'))};
const out='bench/results/2026-09-30-mongo-reeval/r9-impl';mkdirSync(out,{recursive:true});writeFileSync(`${out}/model-verification.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
