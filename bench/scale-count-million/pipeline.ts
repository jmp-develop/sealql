import {loadBase} from './load.js';
import {measureScale} from './measure.js';
import {cloneMillion} from './clone.js';
import {connect,locked,save,schema,assert,status,OUT,readFileSync} from './common.js';
import {existsSync} from 'node:fs';
import {headRecheck} from './head-recheck.js';
const previous=existsSync(`${OUT}/progress.json`)?JSON.parse(readFileSync(`${OUT}/progress.json`,'utf8')):null;
const progress:any=previous?.createdSchema&&!previous.complete&&!previous.cleaned?previous:{started:new Date().toISOString(),commit:process.env.SEALQL_SCALE_COMMIT,schema,loaded:0,baseComplete:false,cloneComplete:false,complete:false,errors:[],method:'Public API raw 100k then nine SQL copies with deterministic IDs; tokens/salts/stamps/ciphertexts retained; count-cost only, cloned rows cannot authenticate under new IDs'};
if(progress.commit!==process.env.SEALQL_SCALE_COMMIT){assert.equal(progress.commit,'67e5f62eb69c16c6bea3c895d72e5fd85a108a2c');assert(process.env.SEALQL_SCALE_COMMIT?.startsWith('7c14bda'));progress.ingestCommit=progress.commit;progress.commit=process.env.SEALQL_SCALE_COMMIT;}if(previous?.createdSchema)progress.resumedAt=new Date().toISOString();
const result:any={started:progress.started,commit:progress.commit,complete:false,rows:[],plans:[],errors:[],method:progress.method};let pool:Awaited<ReturnType<typeof connect>>|undefined;
try{save('progress',progress);const data=await loadBase(progress);pool=await connect();await headRecheck(pool,data,progress.commit);await measureScale(pool,data,100000,result);await cloneMillion(pool,progress);await measureScale(pool,data,1000000,result);
 await locked(async()=>{result.capacity=[];for(const table of ['customers','customers_seal_index','customers_plain'])result.capacity.push({table,...(await pool!.query('select pg_relation_size($1)::text heap,pg_indexes_size($1)::text indexes,pg_total_relation_size($1)::text total',[schema+'.'+table])).rows[0]});});
 assert.equal(result.rows.length,36);result.complete=true;progress.complete=true;result.finished=new Date().toISOString();save('measure',result);
}catch(error){progress.errors.push(String(error));result.errors.push(String(error));save('measure',result);throw error;}
finally{if(pool)await pool.end();if(progress.createdSchema){const cleanup=await connect();try{await locked(async()=>{assert.equal(schema,'test_scale_count_million_v_astra');await cleanup.query(`drop schema ${schema} cascade`);assert.equal((await cleanup.query('select to_regnamespace($1) n',[schema])).rows[0].n,null);progress.cleaned=true;});}finally{await cleanup.end();}}progress.finished=new Date().toISOString();save('progress',progress);status('100만 count 작업 상태',`측정 완료=${progress.complete}, 자기 스키마 삭제=${progress.cleaned??false}, 오류=${progress.errors.length}; 원시 결과를 보존했습니다.`);}
