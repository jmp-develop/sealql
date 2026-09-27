import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { normalizeText, normalizeWords, profiles, searchPieces } from '../../src/core/search-tokens.js';
import { createSealer } from '../../src/index.js';
import { binding, guard, pool } from '../standard-next/common.js';
const out='bench/results/2026-09-27-core-verification/v1';
const cases:any[]=[];
try{
  await guard();await mkdir(out,{recursive:true});
  process.env.SEALQL_BENCH_PRODUCT_MULTI_TABLE='customers_skip_product_multi';
  const repo=binding('customers',true).repo;
  for(const value of ['','a','한',' ']){
    try{await repo.findMany({match:f=>f.name.contains(value),limit:1});cases.push({name:`short:${JSON.stringify(value)}`,verdict:'결함'});}
    catch(e:any){assert.equal(e.code,'QUERY_TOO_BROAD');cases.push({name:`short:${JSON.stringify(value)}`,verdict:'통과',code:e.code});}
  }
  const equal=[['한글','한글'],['AB12','ＡＢ１２'],['Foo','fOO'],['a  b','a b']];
  for(const [a,b] of equal){assert.equal(normalizeText(a,'legacy-text-v1'),normalizeText(b,'legacy-text-v1'));cases.push({name:`normalization:${a}/${b}`,verdict:'통과'});}
  const p=profiles('input','body',{type:'text',search:{substring:{wordBoundary:true}}})[0];
  assert.equal(p.skipGrams,true);
  assert.equal(searchPieces(p,'a'.repeat(2048),'write').length>0,true);
  try{searchPieces(p,'a'.repeat(2049),'write');cases.push({name:'2049 characters',verdict:'결함'});}
  catch(e:any){assert.equal(e.code,'LIMIT_EXCEEDED');cases.push({name:'2049 characters',verdict:'통과',code:e.code});}
  const sealer=createSealer({key:new Uint8Array(32).fill(93)}),ring=sealer.ring('input');
  const context={modelId:'input',fieldId:'body',keyScopeId:ring.keyScopeId,scopeId:'scope',rowId:'row',spec:{type:'text' as const,maxBytes:16}};
  const envelope=await sealer.seal('a'.repeat(16),context,ring);
  assert.equal(await sealer.open(envelope,context,ring),'a'.repeat(16));
  cases.push({name:'maxBytes:16',verdict:'통과'});
  try{await sealer.seal('a'.repeat(17),context,ring);cases.push({name:'maxBytes:17',verdict:'결함'});}
  catch(e:any){assert.equal(e.code,'LIMIT_EXCEEDED');cases.push({name:'maxBytes:17',verdict:'통과',code:e.code});}
  cases.push({name:'normalized word spacing',verdict:normalizeWords('  ＡＢ  CＤ  ')==='ab cd'?'통과':'결함'});
  await writeFile(`${out}/input.json`,JSON.stringify({cases},null,2)+'\n');console.log(JSON.stringify(cases));
}finally{await pool.end();}
