import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {getTableColumns} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/node-postgres';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {connect,fields,scope,assert} from '../../final-return/common.js';
import {productSchema,customers,customersSeal,sealed} from './product.js';

const out='bench/results/2026-09-29-lasthour/v-astra';
mkdirSync(out,{recursive:true});
const save=(name:string,value:unknown)=>writeFileSync(`${out}/${name}.json`,JSON.stringify(value,null,2)+'\n');
const requested=process.argv[process.argv.indexOf('--commit')+1];
assert(process.argv.includes('--commit')&&/^[a-f0-9]{7,40}$/.test(requested));
const head=spawnSync('rtk',['proxy','git','rev-parse','HEAD'],{encoding:'utf8'});
assert.equal(head.status,0);const commit=head.stdout.trim();assert(commit.startsWith(requested));
assert(!Object.values(getTableColumns(customersSeal)).some(c=>/^(single|word)_/.test(c.name)));
const pool=await connect(4),db=drizzle(pool);
const result:any={started:new Date().toISOString(),commit,schema:productSchema,scope,loaded:0,complete:false,errors:[],method:'Public sealed.insert; four concurrent batches of 500 original fixture rows; ingestion duration is progress only, not an isolated performance benchmark.',fixture:'bench_realistic_100k.customers',fields,configuration:{keyByte:93,exactCompanyBits:2,otherExactBits:16,substring:true,wordBoundary:false},cleanupOwner:'r9-impl/coordinator after regression; retain schema for handoff'};
try{
 assert.equal((await pool.query('select to_regnamespace($1) n',[productSchema])).rows[0].n,null,'A fresh schema is required; never replace existing data');
 const rows=(await pool.query(`select id,scope_id as "scopeId",${fields.map(f=>f+'_plain as '+f).join(',')} from bench_realistic_100k.customers where scope_id=$1 order by id`,[scope])).rows;
 assert.equal(rows.length,100000);result.sourceHash=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 await pool.query(`create schema ${productSchema}`);
 const snapshot=generateDrizzleJson({customers,customersSeal});
 const migration=await generateMigration(generateDrizzleJson({}),snapshot),extra=sealed.extraMigrationSql(customersSeal);
 save('schema',{snapshot,migration,extra});
 for(const sql of migration)await pool.query(sql);
 for(const sql of extra)await pool.query(sql);
 const start=performance.now();
 for(let offset=0;offset<rows.length;offset+=2000){
  await Promise.all(Array.from({length:4},(_,worker)=>sealed.insert(db,customersSeal,rows.slice(offset+worker*500,offset+(worker+1)*500))));
  result.loaded=Math.min(offset+2000,rows.length);result.elapsedMs=performance.now()-start;save('load',result);
  console.log(JSON.stringify({loaded:result.loaded,elapsedMs:Math.round(result.elapsedMs)}));
 }
 result.tableCounts={};
 for(const name of ['customers','customers_seal_index']){
  await pool.query(`analyze ${productSchema}.${name}`);
  const count=(await pool.query(`select count(*)::int n from ${productSchema}.${name}`)).rows[0].n;
  assert.equal(count,100000);result.tableCounts[name]=count;
 }
 const opened=await sealed.open(await db.select().from(customers).orderBy(customers.id).limit(100));
 for(let i=0;i<100;i++)for(const f of fields)assert.equal((opened[i] as any)[f],rows[i][f]);
 result.rawRoundtripFields=600;result.finished=new Date().toISOString();result.complete=true;save('load',result);
 writeFileSync(`${out}/report-ko.md`,[
  '# 마지막 1시간 검증: 공개 API 적재',
  '',
  `최종 제품 빌드 기준: \`${commit}\`. 지정 스키마 \`${productSchema}\`에 원문 100000행을 공개 \`sealed.insert\`로 적재했다.`,
  '',
  '| 항목 | 결과 |','|---|---|',
  '| 원본 | 보호 fixture의 *_plain 6칸, 원문 공백·대소문자 유지; 읽기만 |',
  '| 경로 | 공개 패키지 API, 4연결 × 500행 배치 |',
  '| 스키마 | test_lasthour_product |',
  '| 설정 | 회사 exact 2비트, 나머지 기본16비트, substring 사용, wordBoundary 없음 |',
  '| 설치 | Drizzle 생성 마이그레이션 + extraMigrationSql + 적재 후 ANALYZE |',
  '| 행 수 | 부모 100000 / 검색 표 100000 단언 통과 |',
  '| 원문 확인 | 첫100행 × 6칸 = 600칸 인증 복호화 원문 일치 |',
  '| 시간 | 적재 진행 시간만 기록; 격리 성능 측정 아님 |',
  '| 인계 | r9-impl 회귀 검증을 위해 스키마 유지, 검증 후 담당자/코디네이터 정리 |',
  '',
  '근거: [load.json](load.json), [schema.json](schema.json), [적재 스크립트](../../../lasthour/v-astra/load.ts).',
  '',
  '일회용 클러스터 검사와 포트 검사를 통과한 뒤 작업했다. 제품 코드 변경 없음. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.',
  '',
 ].join('\n'));
 console.log(JSON.stringify({complete:true,schema:productSchema,loaded:result.loaded,rawRoundtripFields:600}));
}catch(error){result.errors.push(error instanceof Error?error.message:String(error));save('load',result);throw error;}
finally{await pool.end();}
