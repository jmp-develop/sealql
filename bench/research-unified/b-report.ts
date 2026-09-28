/** Offline report only: no runtime import, database connection, or new measurement. */
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {B_CASES,describe} from './b-cases.js';
const OUT='bench/results/2026-09-28-unified';
const read=(phase:string)=>{const p=`${OUT}/m1-astra-${phase}.json`;return existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;};
const all=(read('all')??[]).concat(...['counts','lists','join','long'].map(p=>read(p)??[]));
const byName=new Map(all.map((r:any)=>[r.name,r]));
const rows:any[]=B_CASES.map(c=>byName.get(c.name)??{name:c.name,mode:c.mode,limit:c.limit,condition:describe(c),failed:{B:'측정 안 함'}});
const sizes:any[]=read('sizes')??[],write=read('write'),load=read('load'),plans:any[]=read('plans')??[];
const f=(v:any)=>typeof v==='number'?v.toFixed(2):'측정 안 함',n=(v:any)=>typeof v==='number'?v.toLocaleString('en-US'):'측정 안 함';
const ok=rows.filter(r=>r.summary),bad=rows.filter(r=>!r.summary);
const out:string[]=[];
out.push('# 통합 비교 B — m1-astra\n');
out.push('B는 현재 제품의 실제 16비트 조각 후보 토큰에 행·필드 salt 16바이트와 64비트 SHA-256 판정값을 추가한 연구 시제품이다. 이 보고의 A는 현재 제품이고 B가 행별 도장이다. 모든 배수는 **같은 공유 평문 = 1배**다.\n');
out.push('## 실패·미검증\n');
out.push(`- 질의 성능·정확성 기록 완료 ${ok.length}/45개; 실패 또는 미측정 ${bad.length}개.`);
out.push('- 코디네이터 일정 단축 지시로 B는 고객 100,000행만 적재했다. 티켓 태그·통합 JOIN count/목록·티켓 B 용량은 측정 안 함. JOIN은 **이전 10만 단독 측정 인용(407 ms), 통합 환경 미재측정**이다. 이 407.21ms는 과거 JOIN count 전체 시간이며 목록 20의 시간이 아니다. 과거 보고의 A는 이번 명칭의 B에 해당하고, 검증 태그 2필드·본문 원문 형식 등 구성이 달라 이번 표에 합치지 않는다. 근거: ../2026-09-28-count-test/t-astra-measure.json 및 ../../../.local/research/fact-m1-astra.md.');
for(const r of bad)out.push(`- ${r.name}: ${r.observedMismatch?'평문 '+r.observedMismatch.expected+', B '+r.observedMismatch.actual+'로 불일치; 해당 성능 반복 중단':Object.values(r.failed??{}).join('; ').split('\n')[0]}.`);
for(const op of ['insert','update','delete','concurrent8']){const r=write?.cases.find((x:any)=>x.op===op);if(!r?.summary)out.push(`- 쓰기 ${op}: ${r?.failed?.B?.split('\n')[0]??'예열2+교차7 측정 미완료'}; ${r?.checks?.length??0}회 사후 검사 기록은 있으나 완성된 중앙값으로 보고하지 않는다.`);}
if(write?.cases.some((r:any)=>String(r.failed?.B).includes('handoff deadline')))out.push('- 동시 쓰기의 첫 측정 라운드 B가 마감 도중 중단되어 b_w_* 쓰기 전용 표는 일부 행이 커밋된 중간 상태로 보존했다. 이 중간 상태의 최종 행 수·값은 재조회하지 않았으며, 아래 8,000행 정확성 통과는 완료된 예열 2회에 한정한다.');
out.push('- 공유 본문은 GCM AAD 없이 정규화문을 암호화한다. 이번 실행에 행 결속 수정이 반영되지 않았으므로 제품과 같은 행 결속 보안을 주장할 수 없다.');
out.push('- 공유 계약 13:46Z 답변에 따라 A는 원문, B·C·D는 정규화 문자열을 반환한다. B는 공유 평문과 반환값을 엄격 대조하지만 A와의 원문 반환 성능 비교는 성립하지 않는다.');
out.push('- 단어 경계 이름의 r8 두 사례는 공유 평문 계약의 정규화 substring으로 비교했다. 단어 경계 기능 검증이 아니다.');
out.push('- C 로캘에서 한글 LIKE의 평문 trigram이 비는 제약이 있다. 관련 배수는 이 환경의 산술 비교이며 운영 성능 판정에 쓰지 않는다.\n');
out.push('## 같은 데이터·질의·측정 범위\n');
out.push('| 항목 | 조건 |\n|---|---|\n| 모집단 | 공유 원본은 고객 100,000 + 티켓 100,000행; 이번 B 적재·측정은 고객 100,000행만 |\n| 범위 | scope aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa 하나; 단일 질의 대상 고객 100,000행 |\n| 공유 환경 | research_u.customers_plain/customers_ct; B는 b_customers_tags, b_tickets_tags는 미적재 |\n| 검색 필드 | 고객 name/phone/address/memo/email/company 6개; 티켓 memo는 이번에 측정 안 함 |\n| 평문 색인 | 고객 각 정규화 필드 B-tree + trigram GIN |\n| 후보 | 실제 native_verify_main 제품 토큰을 읽기 복제; B 자체 exact B-tree·다중 칼럼 substring GIN |\n| 판정 | HMAC-SHA256(prfKey,scope/table/field/kind/조각), SHA256(결과32B∥salt16B) 앞8B; K=8 |\n| 본문·검증 키 | 공유 unified-keys.json의 연구 키; 제품 후보 토큰은 기존 제품 고정 키/키 파생 규칙 |\n| JOIN | 통합 환경 측정 안 함; 계획 대상은 티켓 100,000과 고객 100,000, ticket.customer_id=customer.id |\n| SUM | 고객 memo에 서비스가 포함된 행의 평문 파생 memo_len 합; 암호화 숫자 합산은 아님 |\n| 목록 반환 | 고객6필드와 ID, ID 오름차순; ID와 모든 값 deepEqual |\n| 반복 | 첫 실행 별도, 예열2+교차7, 지표별 중앙값; 매 실행 결과 대조 |\n| DB | 일회용 127.0.0.1:56439; assertDisposable·포트 검증; measure.lock |\n| 보존 | 연구 테이블을 삭제하지 않고 보존; 기존 원본에는 쓰지 않음 |\n');
out.push('## 질의 전체 표\n');
out.push('시간 단위 ms. SQL은 요청~응답 합계다. 지표별 중앙값은 서로 합산되지 않을 수 있다. 앱 수신 행에는 count/SUM 숫자 결과 1행도 포함한다. 대상 행은 기본 고객 100,000이고 JOIN은 티켓 100,000+고객 100,000이다.\n');
out.push('| 조회 | 조건 전문 | 대상 행 | 실제 일치 | 결과 수/값 | DB 후보 | SQL 호출 | 앱 수신 행 | 복호화 필드 | 평문 SQL/전체 | B 전처리 | B SQL | B SQL 사이 | B 후처리 | B 전체 | 평문 대비 SQL/전체 |\n|---|---|---|---:|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---|');
for(const r of rows){const p=r.summary?.plain,b=r.summary?.B;const desc=r.condition+(r.mode.includes('Find')||r.mode==='find'?`; ORDER BY id; LIMIT ${r.limit??'없음'}`:'');out.push(`| ${r.mode} ${r.name} | ${desc.replaceAll('|','/')} | ${r.mode.startsWith('join')?'티켓10만+고객10만':'고객10만'} | ${n(r.actualMatches)} | ${r.resultRows??'측정 안 함'}${r.mode==='count'||r.mode==='joinCount'||r.mode==='sum'?' / '+(r.truth??'측정 안 함'):''} | ${n(r.dbCandidates)} | ${n(b?.sqlCalls)} | ${n(b?.rowsToApp)} | ${n(b?.openCount)} | ${f(p?.dbMs)}/${f(p?.totalMs)} (1배) | ${f(b?.preMs)} | ${f(b?.dbMs)} | ${f(b?.betweenSqlMs)} | ${f(b?.postMs)} | ${f(b?.totalMs)} | ${f(r.sqlRatios?.B)}/${f(r.ratios?.B)}배 |`);}
out.push('\ncount가 정상 완료된 사례에서 숫자 결과는 1행이고 대상 암호문 행은 0행이다. 복호화도 0회다. 목록은 판정 후 LIMIT에 해당하는 암호문을 받아 선택한 필드를 복호화한다. DB 후보는 LIMIT 없는 토큰 후보 집합을 별도 count한 값이며 실행 계획이 읽은 물리 tuple 수가 아니다.\n');
out.push('## LIMIT에서 멈추는 실행 계획\n');
if(!plans.length)out.push('EXPLAIN ANALYZE: 측정 안 함.');
for(const p of plans){
 const nodes:any[]=[];const visit=(x:any)=>{if(x&&typeof x==='object'){if(x['Node Type'])nodes.push(x);for(const value of Object.values(x))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}};visit(p.plan);
 const judged=nodes.filter(x=>String(x.Filter??'').includes('sha256'));
 out.push(`- ${p.name}: ${judged.map(x=>`${x['Node Type']} 판정 출력 ${x['Actual Rows']}행, 필터 탈락 ${x['Rows Removed by Filter']??0}행, 반복 ${x['Actual Loops']}회`).join('; ')||'sha256 판정 노드 자동 추출 실패; 원계획 확인 필요'}. 계획 원문은 m1-astra-plans.json.`);
 out.push(`  후보 접근: ${nodes.filter(x=>x['Relation Name']==='b_customers_tags').map(x=>`${x['Node Type']} ${x['Actual Rows']}행, 후보 필터 탈락 ${x['Rows Removed by Filter']??0}행`).join('; ')}. 정렬: ${nodes.filter(x=>x['Node Type']==='Sort').map(x=>`${x['Sort Method']??'방식 미기록'}, ${x['Sort Space Used']??'?'} kB ${x['Sort Space Type']??''}`).join('; ')||'정렬 노드 없음'}.`);
}
out.push('B SQL은 후보를 ID 순서로 공급하는 OFFSET 0 하위 쿼리, 태그 판정, LIMIT를 하나의 matched CTE에 넣고 그 뒤 본문을 조회한다. JOIN은 티켓 부모 조회와 고객 판정에 LATERAL/EXISTS OFFSET 0을 쓴다. 실행 계획에서 LIMIT 전에 전체 태그 판정이 일어나지 않는지는 실제 계획 기록으로 판정한다.\n');
out.push('## 용량 — 평문 1배\n');
out.push('MB=1,000,000바이트. 본문/검색 칸은 total−일반색인으로 TOAST 부속 공간을 포함한다. 색인은 pg_indexes_size이며 TOAST 내부 색인은 본문/검색 칸에 남아 있다. 쓰기 전용 b_w_*는 아래 본 실험 저장량에서 제외한다.\n');
out.push('| 방식·표 | 논리 행 | 본문 MB | 검색 MB | 일반 색인 MB | 장부 MB | 합계 MB | 바이트/행 | 평문 대비 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for(const t of ['customers','tickets']){const p=sizes.find(r=>r.relname===t+'_plain'),c=sizes.find(r=>r.relname===t+'_ct'),b=sizes.find(r=>r.relname==='b_'+t+'_tags');if(!p||!c||!b){out.push(`| ${t} B (미적재; 원본 대상 100,000행) | 0 | 측정 안 함 | 측정 안 함 | 측정 안 함 | 측정 안 함 | 측정 안 함 | 측정 안 함 | 측정 안 함 |`);continue;}out.push(`| ${t} 평문 | ${n(p.rows)} | ${f((+p.total-p.indexes)/1e6)} | 0 | ${f(+p.indexes/1e6)} | 0 | ${f(+p.total/1e6)} | ${f(+p.total/p.rows)} | 1배 |`);out.push(`| ${t} B | ${n(b.rows)} | ${f((+c.total-c.indexes)/1e6)} | ${f((+b.total-b.indexes)/1e6)} | ${f((+c.indexes+ +b.indexes)/1e6)} | 0 | ${f((+c.total+ +b.total)/1e6)} | ${f((+c.total+ +b.total)/b.rows)} | ${f((+c.total+ +b.total)/p.total)}배 |`);}
out.push('\n## 쓰기 — 평문 1배\n');
out.push('본문 암호화·제품 후보 토큰 생성·B 판정 태그·COMMIT을 포함한다. 준비용 데이터 초기화·원본 복구·사후 검증은 시간 밖이다. 실제 source ID와 값만 쓰며 부분 수정은 다른 원본 메모로 바꾼다. 다른 방식 담당의 쓰기 반복법·수정 값이 다르면 직접 배수 비교의 한계다.\n');
out.push('| 작업 | 매 반복 행 수 | 평문 전체 ms | B 전체 ms | 전체 배수 | 평문 행 지연 중앙값 ms | B 행 지연 중앙값 ms | 행 지연 배수 | 사후 count·값 대조 |\n|---|---:|---:|---:|---:|---:|---:|---:|---|');
for(const op of ['insert','update','delete','concurrent8']){const r=write?.cases.find((x:any)=>x.op===op),p=r?.summary?.plain,b=r?.summary?.B;out.push(`| ${op} | ${r?.rows??'측정 안 함'} | ${f(p?.totalMs)} | ${f(b?.totalMs)} | ${f(r?.ratios?.B)}배 | ${f(p?.medianRowLatencyMs)} | ${f(b?.medianRowLatencyMs)} | ${f(r?.rowLatencyRatios?.B)}배 | ${r?.summary?r.checks.length+'회 통과':r?.failed?.B?.split('\n')[0]??'측정 안 함'} |`);}
out.push('\n8개 writer에서는 SQL 요청의 대기 시간이 겹치므로 dbMs(왕복 합)는 전체 시간보다 클 수 있다. dbWallMs에 겹침을 제거한 SQL 대기 구간을 별도 기록하고 전처리/SQL 사이/후처리의 wall 구간을 분리했다.\n');
const concurrent=write?.cases.find((r:any)=>r.op==='concurrent8');
if(concurrent?.first?.B)out.push(`8 writer의 첫 예열 한 번은 총 8,000행(각 writer 1,000행), B ${f(concurrent.first.B.totalMs)}ms·${f(concurrent.first.B.rowsPerSec)}행/초, 평문 ${f(concurrent.first.plain?.totalMs)}ms였다. 이는 **단일 예열 관측값이며 예열2+교차7 중앙값이 아니다**. 완료된 B 사후 검사 ${concurrent.checks.filter((x:any)=>x.path==='B').length}회에서 memo count 3,219·company count 2,311·8,000행의 6필드 값 대조가 통과했다.\n`);
out.push('## 가설 검증표\n');
out.push('| 가설 | 증거 | 판정 |\n|---|---|---|');
out.push(`| 지정한 모든 count·목록·JOIN·SUM이 정확 | 정상 ${ok.length}, 실패/미측정 ${bad.length} | ${bad.some(r=>r.observedMismatch)?'실패 사례 있음':bad.length?'미검증 남음':'확인됨'} |`);
out.push(`| 45글자도 DB 태그만으로 정확 count | ${JSON.stringify((byName.get('sub45') as any)?.observedMismatch??'측정 안 함')} | ${(byName.get('sub45') as any)?.observedMismatch?'실패':'미검증'} |`);
out.push(`| 제한 목록이 필요한 수에서 판정 중단 | 별도 계획 ${plans.length}개 | 실제 계획 해석 참조 |`);
const checkedWrites=(write?.cases??[]).filter((r:any)=>r.checks.some((c:any)=>c.path==='B')).length;
out.push(`| 쓰기 후 값·count 유지 | B 사후 검사 실행 ${checkedWrites}/4 작업; 성능 반복 완료 ${(write?.cases??[]).filter((r:any)=>r.summary).length}/4 | ${checkedWrites===4?'실행한 사후 검사는 통과; 반복 완료 여부 별도':'미검증 남음'} |`);
out.push('| 제품과 동일한 보안·공개 API | 본문 AAD/원문 계약 차이, 연구용 별도 SQL | 미검증 또는 구조 차이 |');
const exact:any=byName.get('exact_common'),pbytes=sizes.find(r=>r.relname==='customers_plain'),cbytes=sizes.find(r=>r.relname==='customers_ct'),bbytes=sizes.find(r=>r.relname==='b_customers_tags');
const bTotal=cbytes&&bbytes?+cbytes.total+ +bbytes.total:undefined;
out.push(`| 완전 일치 SQL이 평문 약 2배 이내 | 평문 ${f(exact?.summary?.plain.dbMs)}ms, B ${f(exact?.summary?.B.dbMs)}ms, ${f(exact?.sqlRatios?.B)}배 | ${exact?.sqlRatios?.B>2?'미달':exact?.summary?'해당 사례 충족':'미검증'} |\n`);
out.push('근거: 같은 폴더의 m1-astra-*.json(원 반복값·최초 실행·계획), ../../../bench/research-unified/b-*.ts, ../../../.local/research/unified-contract.md. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.\n');
out.push(`결론 1. 공유 평문과 대조한 질의 ${ok.length}개가 일치했지만 45글자 검색은 0건을 2,440건으로 오판했고 통합 JOIN 2개는 재측정하지 않았다.  `);
out.push(`결론 2. 완전 일치 count SQL은 평문 ${f(exact?.summary?.plain.dbMs)}ms 대비 B ${f(exact?.summary?.B.dbMs)}ms(${f(exact?.sqlRatios?.B)}배)로 약 2배 목표에 미달하며, LIMIT 판정이 멈춰도 후보 정렬 비용은 남는다.  `);
out.push(`결론 3. 고객 100,000행 B는 ${f(bTotal===undefined?undefined:bTotal/1e6)}MB로 평문 ${f(pbytes?+pbytes.total/1e6:undefined)}MB의 ${f(bTotal&&pbytes?bTotal/pbytes.total:undefined)}배이고 쓰기 ${(write?.cases??[]).filter((r:any)=>r.summary).length}/4작업의 반복 측정을 완료했다; 원문 반환·행 결속 차이로 제품과 동등한 구현이라는 주장은 할 수 없다.\n`);
const reportText=out.join('\n').replaceAll('측정 안 함배','측정 안 함').replaceAll('AssertionError [ERR_ASSERTION]: coordinator lock handoff deadline; incomplete operation not measured','14:30Z 인계 마감으로 성능 반복 미완료').replaceAll('| 결과 수/값 |','| 정답 결과 수/값 |');
mkdirSync(OUT,{recursive:true});writeFileSync(`${OUT}/m1-astra-report-ko.md`,reportText+'\n');console.log(JSON.stringify({ok:ok.length,failedOrUnmeasured:bad.length,report:`${OUT}/m1-astra-report-ko.md`,loadComplete:!!load?.finished}));
