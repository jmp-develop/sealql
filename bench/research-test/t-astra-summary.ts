import {existsSync,readFileSync} from 'node:fs';
const root='bench/results/2026-09-28-count-test';
const get=(n:string)=>existsSync(`${root}/t-astra-${n}.json`)?JSON.parse(readFileSync(`${root}/t-astra-${n}.json`,'utf8')):null;
const m=get('measure');if(m)console.log('matrix',JSON.stringify({cases:m.cases.length,failures:m.failures,rows:m.cases.map((c:any)=>({name:c.name,matches:c.actualMatches,value:c.resultValue,plain:c.summary.plain.totalMs,product:c.summary.product.totalMs,A:c.summary.A.totalMs}))}));
const w=get('write');if(w)console.log('write',JSON.stringify(w.summary));
const e=get('edge');if(e)console.log('edge',JSON.stringify({results:e.results,long:e.long,concurrency:e.concurrency,failures:e.failures}));
const plans=get('plan');if(plans)for(const p of plans){const nodes:any[]=[];const walk=(n:any,level=0)=>{nodes.push({level,type:n['Node Type'],relation:n['Relation Name'],rows:n['Actual Rows'],loops:n['Actual Loops'],removed:n['Rows Removed by Filter'],removedJoin:n['Rows Removed by Join Filter'],sort:n['Sort Method'],startup:n['Actual Startup Time'],total:n['Actual Total Time']});for(const x of n.Plans??[])walk(x,level+1);};walk(p.plan[0].Plan);console.log('plan',p.name,JSON.stringify({execution:p.plan[0]['Execution Time'],nodes}));}
