import { mkdir, writeFile } from 'node:fs/promises';
import { profiles, searchPieces, searchTokens } from '../../src/core/search-tokens.js';
import { binding, fields, guard, pool, schema, scopeId, sealer } from './common.js';

const cases=[{name:'address_mid',field:'address',op:'contains',term:'세종대로'},{name:'email_end',field:'email',op:'endsWith',term:'biz.test'}] as const;
const report=[];
try{
  await guard();const outputDir=process.env.SEALQL_BENCH_OUTPUT_DIR??'bench/results/2026-09-27-standard-next-sqlplan';await mkdir(outputDir,{recursive:true});
  for(const c of cases)for(const skip of [false,true]){
    const b=binding('customers',skip),p=profiles(b.model.id,c.field,b.model.fields[c.field]).find(x=>x.mode==='substring')!;
    const token=await searchTokens(sealer.ring(b.model.id),scopeId,p,searchPieces(p,c.term,c.op));
    const suffix=skip?'_skip':'',col=b.storage.index!.profiles![p.indexId].tokens;
    const sql=`select id,${fields.map(f=>`${f}_ct`).join(',')} from ${schema}.customers${suffix} where scope_id=$1 and id in (select row_id from ${schema}.customers${suffix}_seal_index where scope_id=$1 and ${col} @> $2::bigint[]) order by id limit 27`;
    const explain=(await pool.query(`explain (analyze,buffers,format json) ${sql}`,[scopeId,token])).rows[0]['QUERY PLAN'][0];
    report.push({case:c.name,variant:skip?'skip':'next',tokens:token.length,explain});
  }
  await writeFile(`${outputDir}/explain.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.map(x=>({case:x.case,variant:x.variant,tokens:x.tokens,serverMs:x.explain['Execution Time'],plan:x.explain.Plan['Node Type'],inner:x.explain.Plan.Plans?.[0]?.['Node Type']}))));
  const flatten=(p:any):string[]=>[`${p['Node Type']} ${p['Relation Name']??''} ${p['Index Name']??''} rows=${p['Actual Rows']??''}`,...(p.Plans??[]).flatMap(flatten)];
  for(const x of report)console.log(`${x.case}/${x.variant}: ${flatten(x.explain.Plan).join(' > ')}`);
}finally{await pool.end();}
