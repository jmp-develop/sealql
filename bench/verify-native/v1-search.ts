import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { normalizeText, normalizeWords } from 'sealql';
import { assertDisposable } from '../../test/disposable.js';
import { customersSeal, fields, sealed, scopeId } from './schema.js';

type Field=typeof fields[number];
type Leaf={field:Field;op:'eq'|'contains'|'startsWith'|'endsWith'|'like';value:string;respectWords?:boolean};
type Node=Leaf|{all:Node[]}|{any:Node[]};
type Row={id:string;[key:string]:string};
const norm=(x:string)=>normalizeText(x,'legacy-text-v1');
let seed=21027;
function rng(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;}
function likePattern(p:string){return norm(p).replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/%/g,'.*').replace(/_/g,'.');}
function matches(row:Row,n:Node):boolean{
  if('all'in n)return n.all.every(x=>matches(row,x));if('any'in n)return n.any.some(x=>matches(row,x));
  const value=norm(row[n.field]),term=norm(n.value);
  if(n.op==='eq')return value===term;if(n.op==='startsWith')return value.startsWith(term);
  if(n.op==='endsWith')return value.endsWith(term);if(n.op==='like')return new RegExp(`^${likePattern(n.value)}$`,'u').test(value);
  if(n.respectWords)return normalizeWords(row[n.field]).includes(normalizeWords(n.value));return value.includes(term);
}
function compile(n:Node,m:any):any{
  if('all'in n)return m.and(...n.all.map(x=>compile(x,m)));if('any'in n)return m.or(...n.any.map(x=>compile(x,m)));
  return n.op==='contains'&&n.respectWords?m[n.field].contains(n.value,{respectWords:true}):m[n.field][n.op](n.value);
}
const pool=new Pool({host:'127.0.0.1',port:56439,user:'sealql_test',database:'postgres',options:'-c statement_timeout=120000'});
const db=drizzle(pool), out='bench/results/2026-09-27-native-verification/v1';
async function actual(n:Node){
  const found:any[]=[];let cursor:string|undefined,pages=0;
  do{
    const page=await sealed.findMany(db,customersSeal,{scope:scopeId,match:m=>compile(n,m),
      columns:Object.fromEntries(fields.map(f=>[f,true])) as any,limit:37,cursor,
      budgets:{maxCandidates:20000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024,resultBytes:32*1024*1024,deadlineMs:30000}});
    found.push(...page.items);pages++;assert(pages<5000);assert.notEqual(page.nextCursor,cursor);
    cursor=page.nextCursor??undefined;
  }while(cursor);
  return {found,pages};
}
function same(found:any[],expected:Row[],label:string){
  assert.equal(found.length,expected.length,`${label}/count`);
  for(let i=0;i<found.length;i++){
    assert.equal(found[i].id,expected[i].id,`${label}/id/${i}`);
    for(const f of fields)assert.equal(found[i][f],expected[i][f],`${label}/${f}/${i}`);
  }
}
try{
  await assertDisposable(pool);assert.equal(Number((await pool.query('show port')).rows[0].port),56439);
  assert.equal(Number((await pool.query('select count(*) n from native_verify_main.customers')).rows[0].n),100000);
  await mkdir(out,{recursive:true});
  const rows=(await pool.query(`select id,${fields.map(f=>`${f}_plain as ${f}`).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scopeId])).rows as Row[];
  assert.equal(rows.length,100000);
  const report:any={schema:'native_verify_main',seed:21027,fixtureRows:100000,random:{requested:1000,passed:0,attempts:0,skippedBroad:0},wide:[]};
  let attempts=0;
  while(report.random.passed<1000&&attempts<10000){
    attempts++;
    const leaves:Leaf[]=[];
    for(let j=0;j<(rng()<.55?1:2);j++){
      const row=rows[Math.floor(rng()*rows.length)],field=fields[Math.floor(rng()*fields.length)],chars=Array.from(norm(row[field]));
      if(chars.length<2)continue;const width=Math.min(chars.length,2+Math.floor(rng()*5));
      const start=Math.floor(rng()*(chars.length-width+1));leaves.push({field,op:'contains',value:chars.slice(start,start+width).join('')});
    }
    if(!leaves.length)continue;const node:Node=leaves.length===1?leaves[0]:rng()<.5?{all:leaves}:{any:leaves};
    const expected=rows.filter(row=>matches(row,node));if(expected.length>150){report.random.skippedBroad++;continue;}
    const {found,pages}=await actual(node);same(found,expected,`random/${attempts}`);
    const count=await sealed.count(db,customersSeal,{scope:scopeId,match:m=>compile(node,m),maxCandidates:20000,
      budgets:{deadlineMs:30000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024}});
    assert.equal(count,expected.length,`count/${attempts}`);
    report.random.passed++;report.random.attempts=attempts;
    if(report.random.passed%50===0){console.log(JSON.stringify({random:report.random.passed,attempts}));await writeFile(`${out}/search.json`,JSON.stringify(report,null,2)+'\n');}
    void pages;
  }
  assert.equal(report.random.passed,1000);
  for(const [name,field,term] of [['address','address','세종대로'],['company','company','서울서비스']] as const){
    const node:Node={field,op:'contains',value:term},expected=rows.filter(row=>matches(row,node));
    const {found,pages}=await actual(node);same(found,expected,`wide/${name}`);
    const count=await sealed.count(db,customersSeal,{scope:scopeId,match:m=>compile(node,m),maxCandidates:110000,
      budgets:{deadlineMs:30000,fetchBytes:32*1024*1024,decryptedBytes:32*1024*1024}});
    assert.equal(count,expected.length);report.wide.push({name,rows:expected.length,pages,count});console.log(JSON.stringify(report.wide.at(-1)));
    await writeFile(`${out}/search.json`,JSON.stringify(report,null,2)+'\n');
  }
  await assert.rejects(sealed.count(db,customersSeal,{scope:scopeId,match:m=>m.company.contains('서비'),maxCandidates:1}),{code:'LIMIT_EXCEEDED'});
  report.budget='LIMIT_EXCEEDED';await writeFile(`${out}/search.json`,JSON.stringify(report,null,2)+'\n');
}finally{await pool.end();}
