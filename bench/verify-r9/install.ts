/** Run only after the coordinator announces the predicate fix is complete. */
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

assert(process.argv.includes('--fix-announced'),'Coordinator fix-complete announcement is required');
const lock='.local/research/measure.lock',owner=`final-measure-install ${process.pid}`;
writeFileSync(lock,owner,{flag:'wx'});
try{
 const build=spawnSync('rtk',['npm','run','build'],{stdio:'inherit'});assert.equal(build.status,0,`Build failed: ${build.error??''}`);
 const commit=spawnSync('rtk',['git','rev-parse','HEAD'],{encoding:'utf8'});assert.equal(commit.status,0);
 const {connect,model,save,sealed,OUT}=await import('./common.js');
 const {generateDrizzleJson,generateMigration}=await import('drizzle-kit/api');
 const pool=await connect();
 try{
  const installed=[],indexMigrations=[];
  for(const schema of ['test_r9_verify_main']){
   if(!(await pool.query('select to_regnamespace($1) n',[schema])).rows[0].n)continue;
   const h=model(schema);
   if(schema==='test_r9_verify_main'){
    const previous=JSON.parse(readFileSync(`${OUT}/schema.json`,'utf8')).snapshot,current=generateDrizzleJson({customers:h.table,customersSeal:h.seal});
    const changes=await generateMigration(previous,current);for(const statement of changes){assert(!/drop table|drop column|alter column.*type/i.test(statement),'Storage-format migration is outside the announced fix');await pool.query(statement);}indexMigrations.push({schema,changes,current});
   }
   for(const statement of sealed.extraMigrationSql(h.seal))await pool.query(statement);
   await pool.query(`analyze ${schema}.customers`);await pool.query(`analyze ${schema}.customers_seal_index`);installed.push(schema);
  }
  if((await pool.query("select to_regnamespace('test_r9_verify_join') n")).rows[0].n){const {ticketsSeal}=await import('./join-schema.js');for(const statement of sealed.extraMigrationSql(ticketsSeal))await pool.query(statement);installed.push('test_r9_verify_join');}
  const functions=[];
  for(const schema of installed)functions.push(...(await pool.query("select n.nspname schema,p.proname name,md5(pg_get_functiondef(p.oid)) definition_md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname like 'sealql_%' order by proname",[schema])).rows);
  save('install',{at:new Date().toISOString(),commit:commit.stdout.trim(),installed,indexMigrations,functions,build:'npm run build passed under measurement lock'});
  console.log(JSON.stringify({commit:commit.stdout.trim(),installed}));
 }finally{await pool.end();}
}finally{if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}
