import {connect,fields,scope,assert,readFileSync,save,normalize} from './common.js';
import {compile} from './research-query.js';
import {oracle} from './oracle.js';
const pool=await connect();try{
 const raw=(await pool.query(`select id,${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows,data=raw.map(r=>({id:r.id,...Object.fromEntries(fields.map(f=>[f,normalize(r[f])]))}));
 const cases=JSON.parse(readFileSync('bench/results/2026-09-29-task4/cases.json','utf8')),checks=[];assert.equal(cases.length,52);
 for(const c of cases){const expected=data.filter(r=>oracle(c.node,r)),q=await compile(c.node,'count'),got=(await pool.query(q.text,q.params)).rows[0].n;assert.equal(got,expected.length,c.name);const list=await compile(c.node,'list300'),ids=(await pool.query(list.text,list.params)).rows.map(r=>r.id);assert.deepEqual(ids,expected.slice(0,300).map(r=>r.id),c.name+' IDs');checks.push({name:c.name,matches:got,ids:ids.length});}
 save('baseline-check',{at:new Date().toISOString(),complete:true,checks,scope:'Correctness only; may overlap product correctness tests, no timings reported'});console.log(JSON.stringify({complete:true,cases:checks.length}));
}finally{await pool.end();}
