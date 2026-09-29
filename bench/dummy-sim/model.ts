/** Research-only D-k phone candidate-token model. No DB access. */
import {createHash} from 'node:crypto';
import {norm,unique,type Model} from '../competitor-sim/models.js';

export type DummyMode='R'|'H';
export interface DummyOptions {
  k:0|1|3;
  mode:DummyMode;
  rowId:string;
  /** R changes with every write; H deliberately ignores this value. */
  write:number;
  seed:number;
}
export interface DummyRow {
  value:string;
  dummies:string[];
  /** True exact token plus the union of true and dummy substring tokens. */
  tokens:string[];
  substringTokens:string[];
}

function seededRandom(label:string){
  let block=Buffer.alloc(0),offset=0,counter=0;
  return ()=>{
    if(offset+4>block.length){block=createHash('sha256').update(label).update('\0').update(String(counter++)).digest();offset=0;}
    const value=block.readUInt32BE(offset);offset+=4;return value/0x1_0000_0000;
  };
}

export function makePhoneSampler(reference:string[]){
  const values=reference.map(norm),format=values[0];
  if(!format||!values.every(v=>v.length===format.length&&/^\d+(?:-\d+)+$/.test(v)))throw new Error('Expected one fixed digit-and-hyphen phone format');
  const prefixEnd=format.indexOf('-'),counts=new Map<string,number>();
  for(const value of values){const prefix=value.slice(0,prefixEnd);counts.set(prefix,(counts.get(prefix)??0)+1);}
  const prefixes=[...counts],total=values.length;
  function sample(random:()=>number){
    let target=random()*total,prefix=prefixes.at(-1)![0];
    for(const [candidate,count] of prefixes){target-=count;if(target<0){prefix=candidate;break;}}
    let result=prefix;
    for(let i=prefixEnd;i<format.length;i++)result+=format[i]==='-'?'-':String(Math.floor(random()*10));
    return result;
  }
  return {format,prefixLength:prefixEnd,prefixes:prefixes.length,sample};
}

export type PhoneSampler=ReturnType<typeof makePhoneSampler>;

/**
 * H uses only seed/key surrogate + row id + dummy ordinal, so rewrites are stable.
 * R additionally uses the write nonce, so the same row gets fresh dummy values.
 */
export function makeDummyRow(model:Model,sampler:PhoneSampler,value:string,options:DummyOptions):DummyRow {
  const truth=norm(value),dummies:string[]=[];
  for(let ordinal=0;ordinal<options.k;ordinal++){
    const nonce=options.mode==='H'?0:options.write;
    const random=seededRandom(`dummy-phone/${options.mode}/${options.seed}/${options.rowId}/${nonce}/${ordinal}`);
    for(let attempt=0;attempt<1000;attempt++){
      const candidate=sampler.sample(random);
      if(candidate!==truth&&!dummies.includes(candidate)){dummies.push(candidate);break;}
    }
    if(dummies.length!==ordinal+1)throw new Error('Unable to draw a distinct dummy phone');
  }
  const trueTokens=model.tokens(truth),dummySubstring=dummies.flatMap(v=>model.tokens(v).filter(t=>t.startsWith('s:')));
  const substringTokens=unique([...trueTokens.filter(t=>t.startsWith('s:')),...dummySubstring]);
  return {value:truth,dummies,tokens:unique([...trueTokens.filter(t=>!t.startsWith('s:')),...substringTokens]),substringTokens};
}
