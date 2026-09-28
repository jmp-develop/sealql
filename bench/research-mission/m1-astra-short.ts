import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHmac,hkdfSync} from 'node:crypto';
import {Pool} from 'pg';
import {assertDisposable} from '../../test/disposable.js';
import {profiles,searchPieces,descriptorBytes,normalizeText} from '../../src/core/search-tokens.js';
import {frame} from '../../src/core/bytes.js';
const n=10000,scope='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres'});
const pct=(a:number,b:number)=>+(100*a/b).toFixed(4);const results:any=[];
try{await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);const rows=(await pool.query('select name_plain,company_plain,phone_plain from bench_realistic_100k.customers where scope_id=$1 order by id limit $2',[scope,n])).rows;
 let x=99;const order=Array.from({length:n},(_,i)=>i);for(let i=n-1;i>0;i--){x^=x<<13;x^=x>>>17;x^=x<<5;const j=Math.floor((x>>>0)/2**32*(i+1));[order[i],order[j]]=[order[j],order[i]];}
 for(const field of ['name','company','phone']){const p=profiles('mission-astra',field,{type:'text',search:{exact:true}})[0];const key=Buffer.from(hkdfSync('sha384',Buffer.alloc(32,93),Buffer.alloc(0),frame(['sealql/index/v3','global',descriptorBytes(p)]),48));const values=rows.map(r=>normalizeText(r[field+'_plain'],'legacy-text-v1'));
  for(const bits of [16,128]){const tokens=values.map(v=>createHmac('sha384',key).update(frame(['value',scope,searchPieces(p,v)[0]])).digest().subarray(0,bits/8).toString('hex'));
   results.push({field,bits,rows:n,distinctValues:new Set(values).size,known:[1,5,10].map(k=>{const known=new Set(order.slice(0,n*k/100)),dictionary=new Map<string,Set<string>>();for(const i of known){const key=tokens[i]+'/'+Buffer.byteLength(rows[i][field+'_plain']);if(!dictionary.has(key))dictionary.set(key,new Set());dictionary.get(key)!.add(values[i]);}let guesses=0,correct=0;for(let i=0;i<n;i++){if(known.has(i))continue;const v=dictionary.get(tokens[i]+'/'+Buffer.byteLength(rows[i][field+'_plain']));if(v?.size===1){guesses++;if(v.has(values[i]))correct++;}}return {knownPct:k,correctFullValuePct:pct(correct,n-known.size),guesses,correct,precisionPct:guesses?pct(correct,guesses):null};})});
  }
 }
 writeFileSync('bench/results/2026-09-28-mission/m1-astra-short.json',JSON.stringify({seed:99,attack:'known exact token plus visible ciphertext byte length',results},null,2)+'\n');console.log(JSON.stringify(results));
}finally{await pool.end();}
