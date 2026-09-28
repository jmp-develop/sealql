import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const root='bench/results/2026-09-29-task1';
const read=(name:string)=>{const p=`${root}/pb1d-astra-${name}.json`;return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):undefined;};
const diag=read('recount')??read('diagnose')??[],short=read('measure-short')??[],sizes=read('sizes')?.sizes??[];
const f=(n:number)=>Number.isFinite(n)?n.toFixed(2):'측정 안 함',n=(x:any)=>Number(x).toLocaleString('en-US');
const label:any={plain:'평문',position2:'위치2',position4:'위치4',occurrence2:'1b순번2',occurrence4:'1b순번4',fast2:'수정순번2',fast4:'수정순번4'};
const both=(x:any)=>x?`${f(x.dbMs)}/${f(x.totalMs)}`:'측정 안 함';
let runs=0,allComplete=true;
for(const ds of ['short','500','1000']){const rows=read(`measure-${ds}`)??[];if(rows.length!==(ds==='short'?6:10))allComplete=false;for(const r of rows)for(const values of Object.values(r.runs) as any[][]){if(values.length!==7)allComplete=false;runs+=values.length;}if(rows.length)assert.equal(new Set(rows.map((r:any)=>r.session.pid)).size,1);}
if(diag.length!==18||!read('recount'))allComplete=false;
for(const ds of ['500','1000'])if(read(`load-${ds}`)?.rows!==1000||(read(`stats-${ds}`)??[]).length!==5)allComplete=false;
const out:string[]=['# 과제 1d — 등장 순번 배치 병목과 긴 값 검증 (m1-astra)','',
'## 실패·미검증','',
`- 최종 요청 비교의 완료 상태: ${allComplete?'전체 완료':'일부 미완료; 아래 표에 실제 완료분만 기록'}. 예열2+교차7을 기준으로 완료된 중앙값을 표시했다. 각 실행에서 count 숫자 또는 ID 정렬 배열을 평문과 단언 비교했다.`,
'- 목록은 ID만 반환하며 앱 복호화0회, SQL1회다. 본문 반환 시간·관리형 쓰기·보안 동등성·운영 성능은 측정 안 함.',
'- 긴 값은 기존 fixture 메모를 이어 붙인 500·1,000자 각1,000행이다. 실제 긴 글이 아니며 반복 템플릿·조각의 출현 빈도가 높을 수 있다. 고객10만 행 결과와 행 수가 다르므로 절대 시간을 규모 효과와 분리해야 한다.',
'- 한글 포함 평문 LIKE는 C 로캘 제약으로 배수 성능 판정에서 제외한다. 도장64비트 충돌이 없는 경우의 논리와 측정한 정합성을 구분하며 무조건적인 오탐0을 주장하지 않는다.',''];
out.push('- 1,000자 희귀20·45글자 count에서 수정 순번은 Seq Scan, 기존 위치 도장은 Bitmap GIN을 선택했다. 후보1건이어도 후보를 찾는 방식이 달라 지연이 역전되었다. 이 추가 계획 차이는 확인했지만 함수 비용 설정 등 후보 접근 계획을 바꾼 재측정은 하지 않았다.');
out.push('- **외부 부하 겹침 확인:** 단문20:22–20:23Z 비교는 MongoDB 적재와 겹치지 않았다. 500자·1,000자 비교는 전부 MongoDB 적재와 겹쳤다. MongoDB 적재 시작20:24:47Z·20:25:33Z, 약20:30Z 중단,20:30:26Z 재시작 후 계속 진행이라는 코디네이터 통보를 반영했다. 출처는 m2-fable mongo-lab의 out/m2-lock.log와 m2-load.log(코디네이터 전달, 이 담당이 로그를 독립 재검증한 것은 아님).',
'- 동시 MongoDB 적재는 약40문서/초, 재시작 이후10만 문서까지 약40분이라는 코디네이터의 추정이다. 장문 SQL 경로끼리는 같은 세션에서 교차했지만 외부 부하가 없는 장문 재측정은 하지 않았다. 외부 부하로 인한 지연 증가율은 측정 안 함.');
for(const name of ['diagnose-short-error','load-500-error','load-1000-error','measure-short-error','measure-500-error','measure-1000-error','stats-500-error','stats-1000-error']){const e=read(name);if(e)out.push(`- 실행 기록 ${name}: ${e.message}`);}
out.push('','## 원인과 수정','',
'1b 구현은 각 창의 등장 위치를 전부 열거하고 최초 미존재도 확인한 뒤, 위치 집합을 만들고 교차했다. 수정 함수 research_u.pb_1d_fast는 첫 창의 등장 순번을 하나씩 확인하고, 그 시작 위치에 필요한 다음 창의 위치를 찾는 즉시 해당 창을 통과시킨다. 모든 창이 맞으면 바로 반환하고, 다음 창의 위치가 목표보다 커지거나 더 이상 없으면 그 시작 위치를 버린다. 등장 순번에 따른 위치가 증가하므로 이 조기 중단은 같은 문자열 판정을 보존한다.','',
'저장 배치·salt·등장 순번·도장 길이는 바꾸지 않았다. 기존 pb_1b_w2·w4는 읽기만 하며 수정 함수만 새로 만들었다. 배열 조회는 PostgreSQL 내장 array_position이다. 해시·조회 계수의 내부 누적 비용도 순번 함수의 측정 시간에 포함된다.','',
'| 비교 묶음 | backend PID | 시작 UTC | 종료 UTC |','|---|---:|---|---|');
for(const ds of ['short','500','1000']){const r=read(`measure-${ds}`)??[];out.push(`| ${ds==='short'?'고객10만':ds+'자1000행'} | ${r[0]?.session.pid??'미실행'} | ${r[0]?.session.started??(ds==='short'?'20:22Z대(도구 로그, 분 단위)':'미실행')} | ${r.at(-1)?.finished??(ds==='short'?'20:23Z대(도구 로그, 분 단위)':'진행 중')} |`);}
out.push('',
'## EXPLAIN ANALYZE BUFFERS — 고객10만 행','',
'EXPLAIN은 교차 반복과 별도의1회 서버 실행이다. 아래 시간은 클라이언트 SQL 왕복 중앙값이 아니다. 버퍼는8KiB 블록 단위이며 hit/read는 shared, temp는 임시 read/write다. 아래 노드별 원문은 계측 교정 후 pb1d-astra-recount.json에 저장했다(초기 계획은 pb1d-astra-diagnose.json에도 보존). 교정 진단은20:28–20:29Z로 MongoDB 적재와 겹쳤고, 단문 교차 시간 표는 겹치지 않은 별도 세션이다.','',
'| 조건 | 경로 | 서버 실행 ms | shared hit/read | temp read/write | 토큰 후보 |','|---|---|---:|---|---|---:|');
for(const r of diag){const p=r.plan[0].Plan;out.push(`| ${r.name} | ${label[r.path]} | ${f(r.plan[0]['Execution Time'])} | ${p['Shared Hit Blocks']??0}/${p['Shared Read Blocks']??0} | ${p['Temp Read Blocks']??0}/${p['Temp Written Blocks']??0} | ${n(r.candidates)} |`);}
out.push('','| 조건·경로 | 노드(들여쓰기 깊이) | actual total ms/반복 | actual rows/반복 | loops | 제거 행/반복 | shared hit/read |','|---|---|---:|---:|---:|---:|---|');
for(const r of diag){const walk=(p:any,depth:number)=>{out.push(`| ${r.name} ${label[r.path]} | ${depth}: ${p['Node Type']} | ${f(p['Actual Total Time'])} | ${p['Actual Rows']} | ${p['Actual Loops']} | ${p['Rows Removed by Filter']??0} | ${p['Shared Hit Blocks']??0}/${p['Shared Read Blocks']??0} |`);for(const child of p.Plans??[])walk(child,depth+1);};walk(r.plan[0].Plan,0);}
out.push('','## 해시와 배열 조회 계측 — 고객10만 행','',
'기존 위치 SQL은 sha256을 동일 입력·출력의 전용 PL/pgSQL 래퍼 pb_1d_hash로 감싸고, 별도 트랜잭션의 pg_stat_xact_user_functions.calls를 읽었다. 최초 시도에서 누적값이 섞여 후속 측정은 실행 전후 차이로 수정하고, 각 측정 직전에 서로 다른 입력7개의 호출이 정확히7 증가하는지 교정했다. 계측 때만 병렬 worker를 끄고 래퍼를 사용하며 원본 SQL의 지연 측정에는 넣지 않았다. 함수 비용이 계획에 영향을 줄 수 있어 계측 실행의 실제 호출 수로 해석한다. 기존 경로의 ANY 배열 판정은 해시1회당1회이므로 같은 호출 수다. 순번 함수는 실제 SHA256·array_position 호출 수를 반환한다. 배열 원소 비교 횟수는 측정 안 함.','',
'| 조건 | 경로 | 후보 | SHA256 합 | SHA256/후보 | 배열 조회 합 | 계측 방법 |','|---|---|---:|---:|---:|---:|---|');
for(const r of diag){const h=r.stats?.hashes??r.hashStats?.calls;out.push(`| ${r.name} | ${label[r.path]} | ${n(r.candidates)} | ${h??'측정 안 함'} | ${h?f(+h/r.candidates):'측정 안 함'} | ${r.stats?.lookups??r.stats?.comparisons??h??'측정 안 함'} | ${r.stats?'함수 내부 실제 호출 계수':r.hashStats?'pg_stat_xact_user_functions.calls':'계측 실패'} |`);}
out.push('','## 같은 세션 재측정 — 고객10만 행','',
'계획에서 memo_short2의 순번 경로는 Gather와 부분 집계를 사용하는 반면 기존 위치 경로는 비병렬이었다. 따라서 이 조건의 지연 개선은 해시 감소와 PostgreSQL의 병렬 계획 선택을 함께 포함한다. 병렬화만의 기여율은 별도로 측정하지 않았다. 흔한10글자 두 조건은 모든 경로가 비병렬 Bitmap Heap 계획이었다.','',
'첫 측정1회와 예열2회는 원시 JSON에 분리하고,5/7경로 시작 순서를 회전한 교차7회 중앙값을 사용한다. SQL/전체는 ms이며 전체에는 후보 토큰·조각키 준비와 결과 변환이 포함된다. 지표별 중앙값은 합산하지 않는다. 모든 방식은 같은 연결의 backend PID를 확인했다.','',
'| 조건 전문 | 모드 | 실제 일치/후보/반환 | 평문 SQL/전체 | 위치2 | 위치4 | 1b순번2 | 1b순번4 | 수정순번2 | 수정순번4 | 수정2/4 평문 SQL 배수 |','|---|---|---|---|---|---|---|---|---|---|---|');
for(const r of short){const m=r.medians;if(!m)continue;out.push(`| ${r.field} contains "${r.term}" | ${r.mode} | ${r.truth}/${r.candidates.fast2}/${r.resultRows} | ${both(m.plain)} | ${['position2','position4','occurrence2','occurrence4','fast2','fast4'].map(p=>both(m[p])).join(' | ')} | ${f(m.fast2.dbMs/m.plain.dbMs)}/${f(m.fast4.dbMs/m.plain.dbMs)}배 |`);}
out.push('','출처: pb1d-astra-measure-short.json.','',
'## 긴 값의 파생·적재·용량','',
'원본은 기존 fixture에서 파생된 research_u.customers_plain의 같은 scope 고객100,000행이다. ID 오름차순에서 i번째 새 행은 원본 인덱스 i×64부터 연속 메모를 구분자 없이 연결하고 앞 L개의 정규화 Unicode 코드포인트를 취한다. 각 길이1,000행으로 원본 시작 행 ID를 재사용하며, source_start/source_rows를 평문 파생 표에 저장한다. 500자와1,000자의 시작 원본은 같다. 새 문장이나 공개 말뭉치를 생성·적재하지 않았다.','',
'| 길이 | 행 수 | 전체 파생·적재 초(색인 제외) | 후보 토큰 생성 초 | 평문 INSERT 초 | 위치2 계산+INSERT | 위치4 계산+INSERT | 순번2 계산+INSERT | 순번4 계산+INSERT |','|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for(const ds of ['500','1000']){const l=read(`load-${ds}`);if(l)out.push(`| ${ds} | ${l.rows} | ${f(l.wallMs/1000)} | ${f(l.tokensMs/1000)} | ${f(l.plainMs/1000)} | ${['p2','p4','o2','o4'].map(p=>f(((l.hashingMs[p]??0)+(l.insertMs[p]??0))/1000)).join(' | ')} |`);else out.push(`| ${ds} | 측정 안 함 | - | - | - | - | - | - | - |`);}
out.push('','값 파생·직렬화·검사 등 공통 비용 때문에 단계 시간 합계와 전체 시간이 같지 않다. 각 적재는1회이며 행별 COMMIT 쓰기 중앙값이 아니다. 색인 시간은 다음 표에 분리했다.','',
'| 길이 | 표 | 행 수 | 검색 보조 또는 평문 MB | 색인 MB | 전체 MB | B/행 | 평문 대비 | 색인+ANALYZE 초 |','|---|---|---:|---:|---:|---:|---:|---:|---:|');
for(const ds of ['500','1000']){const l=read(`load-${ds}`),p=sizes.find((s:any)=>s.relname===`pb_1d_plain_${ds}`);for(const s of sizes.filter((s:any)=>s.relname.endsWith('_'+ds))){out.push(`| ${ds} | ${s.relname} | ${l?.rows??'미확인'} | ${f((s.total-s.indexes)/1e6)} | ${f(s.indexes/1e6)} | ${f(s.total/1e6)} | ${f(s.total/(l?.rows??NaN))} | ${f(s.total/p?.total)}배 | ${f((l?.indexMs?.[s.relname]??NaN)/1000)} |`);}}
out.push('','MB=1,000,000B. 검색 표는 암호문 본문이 없는 검색 보조이며 전체 암호화 DB 배수가 아니다. 평문은 같은 파생 값·PK·B-tree·trigram GIN을 갖추었고 검색 표는 PK·후보 GIN이다. total−indexes는 TOAST 부속 공간을 포함한다. 출처: pb1d-astra-load-500/1000.json 및 pb1d-astra-sizes.json.');
for(const ds of ['500','1000']){const rr=read(`measure-${ds}`)??[],ss=read(`stats-${ds}`)??[];out.push('',`## ${ds}자 × 1,000행 — 같은 세션 비교`,'','시간은 SQL/전체 ms, SQL1회·앱 복호화0회·목록은ID300개 상한. †는 한글 LIKE로 평문 배수 판정 제외.','',
'| 조건 전문 | 모드 | 일치/후보/반환 | 평문 | 위치2 | 위치4 | 수정순번2 | 수정순번4 | 수정2/4 평문 SQL 배수 |','|---|---|---|---|---|---|---|---|---|');
 for(const r of rr){if(!r.medians)continue;const m=r.medians;out.push(`| memo contains "${r.term}"${/[가-힣]/.test(r.term)?' †':''} | ${r.mode} | ${r.truth}/${r.candidates.fast2}/${r.resultRows} | ${['plain','position2','position4','fast2','fast4'].map(p=>both(m[p])).join(' | ')} | ${f(m.fast2.dbMs/m.plain.dbMs)}/${f(m.fast4.dbMs/m.plain.dbMs)}배 |`);}
 out.push('','| 조건 | 후보/실제 일치 | 위치2 해시/후보 | 위치4 해시/후보 | 수정순번2 해시/후보 | 수정순번4 해시/후보 |','|---|---|---:|---:|---:|---:|');for(const r of ss)out.push(`| ${r.name} | ${r.candidates.fast2}/${r.truth} | ${['position2','position4','fast2','fast4'].map(p=>f(Number(r.stats[p]?.hashes)/(r.candidates[p]||NaN))).join(' | ')} |`);
 out.push('',`출처: pb1d-astra-measure-${ds}.json 및 pb1d-astra-stats-${ds}.json. 첫 측정·원 반복값은 JSON에 분리했다.`);
}
out.push('','## 판정','',
'- 원인 판정은 위 실행 계획·후보당 실제 해시 수·동일 세션 수정 전후 비교를 함께 읽는다. 1b의 전수 등장 목록 생성과 미존재 확인은 존재 판정에 불필요할 수 있으며 수정은 이 작업을 줄인다.','- 위치 검색의 길이 비용을 모든 데이터에 같은 배수로 적용할 수 없다. 기존 SQL도 일치 위치에서 멈추며 새 배치도 반복 조각의 등장 순번과 배열 검색 비용이 늘어난다.','- 원본과 기존 연구 표는 수정하지 않았고 새 pb_1d_* 표·함수는 재측정용으로 보존했다. 보안 결정이나 채택 권고가 아닌 로컬 합성 fixture 실험이다.','',
'| 원인 가설 | 관측 | 판정 |','|---|---|---|',
'| 1b의 모든 등장 위치 수집·미존재 확인이 존재 판정에 과하다 | 흔한10글자 후보당 해시10~11/6회가 수정 후5/3회, 같은 표에서 SQL 지연 감소 | 확인 |',
'| 기존 위치 도장은 이 단문에서도 모든 시작 위치를 탐색한다 | 첫 정답이 위치1이라0·1 두 시작만 검사, 해시6/4회 | 이 사례에서는 성립하지 않음 |',
'| count의 조인·정렬로 중간 행이 불어난다 | 후보는 Bitmap Index/Heap으로 읽고 기존 경로에 generate_series가 있음; short2 순번 경로에는 Gather·부분 집계 | 해당 count 계획에서 조인·정렬 팽창 없음; 병렬 계획 차이는 존재 |',
'| 수정 뒤 남은 단문 지연을 전부 해시 수로 설명할 수 있다 | 해시가 기존보다 적어도 수정 순번의 단문 count가 더 느림 | 해시 수만으로 설명 불가; PL/pgSQL 실행·배열 접근·더 큰 행의 비용별 분리는 미측정 |','');
for(const ds of ['500','1000']){const pp=read(`plans-${ds}`)??[];if(pp.length){out.push('',`### ${ds}자 희귀 조건의 후보 접근 계획`,'','| 조건 | 경로 | 서버 실행 ms | 접근 노드 | shared hit/read |','|---|---|---:|---|---|');for(const r of pp){const nodes:any[]=[];const walk=(p:any)=>{nodes.push(p);for(const c of p.Plans??[])walk(c);};walk(r.plan[0].Plan);const p=r.plan[0].Plan;out.push(`| ${r.name} | ${label[r.path]} | ${f(r.plan[0]['Execution Time'])} | ${nodes.filter(p=>p['Relation Name']).map(p=>p['Node Type']).join(',')} | ${p['Shared Hit Blocks']??0}/${p['Shared Read Blocks']??0} |`);}out.push('',`출처: pb1d-astra-plans-${ds}.json. 별도1회 실행이며 중앙값 표와 구분한다.`);}}
out.push('','결론 1. 1b의 불필요한 위치 목록 생성과 부재 확인을 제거해 단문10글자 count의 해시를10~11/6회에서5/3회로 줄였으나, 기존 위치 도장의6/4회보다 적어도 지연은 더 컸다.  ',
'결론 2. 500·1,000자 각1,000행의 흔한10글자 count는 기존 위치 도장보다 약13~19배 빨라졌지만, 1,000자 반복 불일치는 수정 후에도 약2.8~2.9초였고 희귀 조건은 전체 스캔 선택으로 더 느린 사례가 남았다.  ',
'결론 3. 장문 비교 전체가 MongoDB 적재와 겹쳤으므로 단독 장문 성능은 미검증이며, 이 결과는 운영 성능이나 보안 인증이 아니다.','',
'근거: bench/research-task1/pb1d-astra.ts 및 pb1d-astra-report.ts, bench/results/2026-09-29-task1/pb1d-astra-*.json.');
writeFileSync('.local/research/task1d-m1-astra.md',out.join('\n')+'\n');saveAudit();
function saveAudit(){let combinations=0;for(const ds of ['short','500','1000'])for(const r of read(`measure-${ds}`)??[]){for(const p of Object.keys(r.runs)){assert(r.first[p],'first measurement missing');if(allComplete){assert(r.medians);assert.equal(r.runs[p].length,7);}combinations++;}}writeFileSync(`${root}/pb1d-astra-audit.json`,JSON.stringify({at:new Date().toISOString(),allComplete,measuredRounds:runs,diagnosticRows:diag.length,shortComparisons:short.length,queryPathCombinations:combinations,totalAssertedExecutions:allComplete?combinations*10:null,warmups:2,repeats:7,firstSeparate:true,retainedTables:true},null,2)+'\n');}
console.log('Report saved',allComplete?'complete':'partial',runs);
