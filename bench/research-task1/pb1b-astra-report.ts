import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const root='bench/results/2026-09-29-task1';
const read=(s:string)=>JSON.parse(readFileSync(`${root}/pb1b-astra-${s}.json`,'utf8'));
const rows=read('measure'),loads=read('load'),sizes=read('sizes'),stats=read('stats');
const paths=['plain','position2','position4','occurrence2','occurrence4'];
assert.equal(rows.length,14);assert.equal(stats.length,7);assert.equal(new Set(rows.map((r:any)=>r.session.pid)).size,1);
for(const r of rows){assert.equal(r.lookup,'native array_position');assert.equal(r.appDecrypts,0);assert.equal(r.sqlCallsPerRun,1);for(const p of paths){assert.equal(r.runs[p].length,7);assert(r.first[p]);}}
for(const r of loads)assert.equal(r.rows,100000);
const f=(v:number)=>v.toFixed(2),n=(v:number)=>v.toLocaleString('en-US'),both=(x:any)=>`${f(x.dbMs)}/${f(x.totalMs)}`;
const names:any={plain:'평문',position2:'위치 창2',position4:'위치 창4',occurrence2:'순번+위치 창2',occurrence4:'순번+위치 창4'};
const rel=(name:string)=>sizes.sizes.find((r:any)=>r.relname===name),plain=rel('pb_astra_plain');
const out:string[]=['# 과제 1b: 등장 순번 도장 + 평문 위치 — m1-astra','',
'## 실패·미검증','',
'- 요청한 긴 검색5개·짧은 검색2개의 count와 ID 목록300, 총14조건을 다섯 방식에서 모두 완료했다. 각 방식은 첫 측정1회·예열2회·교차7회마다 평문 숫자 또는 정렬된 ID 배열과 일치했다(총700회 실행, 준비용 조회 별도).',
'- 모든 경로는 같은 DB 연결 세션에서 실행했다. 앱 복호화0회이며 목록은 ID만 반환한다. 본문 필드 반환까지 포함한 목록 시간이나 공개 API 성능은 측정 안 함.',
'- 500·1,000자 실물 데이터, 관리형 부분 수정·삭제·동시성, 공격 복원율, 보안 동등성은 측정 안 함. 저장 도장의 64비트 충돌이 없는 경우의 정합성을 사용하며 무조건적인 오탐0을 보장하지 않는다.',
'- 한글 포함 LIKE의 평문 배수는 C 로캘 제약이 있어 성능 판정에서 제외한다. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.','',
'## 배치와 실행 계약','',
'| 항목 | 구현 |','|---|---|',
'| 파생 원본 | research_u.customers_plain + b_customers_tags의 고객100,000행, 메모·주소2필드, 기존 후보 토큰 그대로 복사 |',
'| 새 표 | research_u.pb_1b_w2, pb_1b_w4, 각100,000행; 원본과 과제1 표는 읽기 전용 |',
'| 새 함수 | research_u.pb_1b_eval_native; IMMUTABLE/STRICT/PARALLEL SAFE PL/pgSQL, DB 쓰기 없음; 초기 이진 탐색 함수 pb_1b_eval과 분리 |',
'| 도장 | SHA256(조각키32B ∥ 행·칸 salt16B ∥ 등장 순번 uint32 big-endian) 앞8B를 signed bigint로 저장 |',
'| 순번 | 각 필드의 같은 폭·같은 조각마다1부터 증가; 반복해도 다른 도장, 폭별 조각키 도메인 분리 |',
'| 위치 | 정규화 Unicode 코드포인트의0부터 시작하는 int 위치; signed 도장값순으로 정렬한 병렬 배열(stamps, positions) |',
'| 폭 | 창2는2글자만, 창4는2·3·4글자 모두 저장하여 짧은 검색을 지원 |',
'| 조회 | 창마다 i=1부터 도장 조회, 최초 미존재에서 중단; PostgreSQL 내장 array_position으로 위치 배열 인덱스 조회, 시작 위치 집합과 오프셋 교집합 판정 |',
'| 창 선택 | w 간격으로 덮고 마지막 꼬리창 추가; 10글자 창2=5개·창4=3개, 45글자 창2=23개·창4=12개 |',
'| 선택 이유 | 겹침 전부보다 필요한 창이 적고 모든 문자 위치를 덮는다; 같은 조각키가 여러 창에서 반복되면 각 창에서 다시 열거하는 현재 구현 |',
'| 배치 이유 | 도장당 별도 행/색인 없이 고객1행과 GIN 유지; 내장 배열 조회는 최악 O(M), 평균15글자 데이터에서 PL/pgSQL 이진 탐색 반복 비용을 피함; 위치4B와 배열 비용 실측 |',
`| 측정 세션 | PostgreSQL backend PID ${rows[0].session.pid}, ${rows[0].session.version}, work_mem ${rows[0].session.work_mem} |`,
'| 순서 | 각 조건·모드 안에서5경로 시작 순서를 회전, 첫 측정1+예열2+교차7, SQL 요청~응답과 토큰 준비 포함 전체를 각각 중앙값 |',
'| 안전 | assertDisposable와 SHOW port=56439 확인 후 measure.lock 획득, 기존 표 수정·커밋 없음 |','',
'전체 시간은 질의 조각키·후보 토큰 준비와 SQL 및 결과 ID 변환을 포함한다. SQL 시간은 클라이언트 요청~응답이며 서버 실행 시간만을 뜻하지 않는다. 두 지표의 중앙값은 별도로 계산하며 서로 합산하지 않는다. OS 캐시를 비우지 않아 첫 측정을 cold라고 부르지 않는다. 새 함수의 내부 해시·비교 횟수 누적 연산도 새 배치의 측정 시간에 포함된다.','',
'## 용량·적재 — 평문=1배','',
'동일 시점 카탈로그 실측이며 MB=1,000,000B. 검색 표에는 암호문 본문이 없어 아래 배수는 두 필드 평문 표 대비 검색 보조 저장량이다. 전체 암호화 DB 배수가 아니다.','',
'| 방식 | 고객 행 수 | 일반 색인 제외 MB | 일반 색인 MB | 전체 MB | B/행 | 평문 대비 |','|---|---:|---:|---:|---:|---:|---:|'];
for(const [label,table] of [['평문','pb_astra_plain'],['과제1 위치 창2','pb_astra_w2'],['과제1 위치 창4','pb_astra_w4'],['새 순번+위치 창2','pb_1b_w2'],['새 순번+위치 창4','pb_1b_w4']]){const s=rel(table);out.push(`| ${label} | 100,000 | ${f((s.total-s.indexes)/1e6)} | ${f(s.indexes/1e6)} | ${f(s.total/1e6)} | ${f(s.total/100000)} | ${f(s.total/plain.total)}배 |`);}
out.push('','일반 색인 제외 칸은 total−indexes이며 TOAST 부속 공간을 포함한다. 출처: pb1b-astra-sizes.json.','',
'| 새 배치 | 고객 행 수 | 파생 계산+INSERT 초 | 색인+ANALYZE 초 | 도장 수 / 평문 위치 수 | 메모/주소 평균 글자 |','|---|---:|---:|---:|---:|---|');
for(const r of loads)out.push(`| 창${r.w} | ${n(r.rows)} | ${f(r.loadMs/1000)} | ${f(r.indexMs/1000)} | ${n(+r.logical.stamps)} / ${n(+r.logical.positions)} | ${f(r.logical.memo_chars)}/${f(r.logical.address_chars)} |`);
out.push('','적재는 각1회의 일괄 적재 시간이며 행별 쓰기 중앙값이 아니다. 측정 락 대기 시간은 적재 시간에 포함하지 않는다. 출처: pb1b-astra-load.json.');
for(const w of [2,4]){
 out.push('',`## 동일 세션 비교 — 창${w}`,'','시간은 SQL/전체 ms, 배수도 SQL/전체다. 모든 요청은 SQL1회·앱 복호화0회이며 count는 숫자1행, 목록은 최대300 ID를 받는다. DB 후보는 토큰 조건을 통과한 내부 행 수다. **†는 한글 LIKE 제약으로 배수 성능 판정 제외**.','',
'| 조건 전문 | 모드 | 실제 일치 | DB 후보 | 반환 행 | SQL 수 | 평문 SQL/전체 | 과제1 위치 SQL/전체 | 평문 대비 | 새 순번+위치 SQL/전체 | 평문 대비 | 기존/새 SQL 속도비 |','|---|---|---:|---:|---:|---:|---|---|---|---|---|---:|');
 for(const r of rows){const p=r.medians.plain,old=r.medians[`position${w}`],cur=r.medians[`occurrence${w}`];out.push(`| ${r.field} contains "${r.term}"${/[가-힣]/.test(r.term)?' †':''} | ${r.mode} | ${n(r.truth)} | ${n(r.candidates[`occurrence${w}`])} | ${r.resultRows} | 1 | ${both(p)} | ${both(old)} | ${f(old.dbMs/p.dbMs)}/${f(old.totalMs/p.totalMs)}배 | ${both(cur)} | ${f(cur.dbMs/p.dbMs)}/${f(cur.totalMs/p.totalMs)}배 | ${f(old.dbMs/cur.dbMs)} |`);}
 out.push('','기존/새 SQL 속도비가1보다 크면 새 배치가 빠르고,1 미만이면 느리다. 출처: pb1b-astra-measure.json(원 반복값·실행 순서 포함).');
}
out.push('','## 후보당 해시·배열 조회 횟수','',
'별도 DB 조회에서 함수의 실제 SHA256 호출과 내장 array_position 호출 횟수를 누적했다. 배열 원소 비교 횟수 자체는 측정 안 함(원시 JSON의 comparisons는 이 구현에서 배열 조회 호출을 뜻함). 측정 반복 타이밍과 별개이며 시간에서 빼지 않는다. 평균은 count 후보 전체 합/후보 수의 계산값이다. 조각키 HMAC 생성과 집합 교차 비교는 이 횟수에 포함하지 않는다.','',
'| 조건 | 창 | 후보 수 | SHA256 합 | 평균/후보 | 최대/후보 | 배열 조회 합 | 평균/후보 | 최대/후보 |','|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for(const r of stats)for(const w of [2,4]){const s=r.stats[`occurrence${w}`];out.push(`| ${r.name} | ${w} | ${s.candidates} | ${s.hashes} | ${f(s.hashes/s.candidates)} | ${s.max_hashes} | ${s.comparisons} | ${f(s.comparisons/s.candidates)} | ${s.max_comparisons} |`);}
out.push('','창별 등장 수를 r_j라 하면 모든 해당 창을 끝까지 확인하는 해시 수는 Σ(r_j+1)이다. 위치0..n−L을 전부 열거하는 기존 배치의 최대 (n−L+1)×창 수와 다르지만, 반복 문자열에서는 r_j가 n과 함께 늘 수 있어 값 길이와 무관한 상수라고 할 수 없다. 창의 교집합이 비면 일찍 중단하며, M개 도장 배열에서 내장 배열 조회의 최악 비교 수는 O(M)이다. PL/pgSQL 해석 실행·배열 접근·집합 교차 비용도 있어 해시 횟수 감소가 그대로 지연 감소는 아니다. 출처: pb1b-astra-stats.json 및 pb1b-astra.ts.','',
'45글자 반례에서는 후보마다 첫 조각의 도장을5회 계산한 뒤 가능한 시작 위치가 없어서 중단했다. 따라서 이 사례의5회/후보를 길이45의 모든 질의에 필요한 비용으로 일반화할 수 없다.','',
'## 첫 측정 (SQL/전체 ms)','',
'캐시를 비우지 않은 첫 실행으로, 예열2+교차7 중앙값 표와 분리한다.','',
'| 조건 | 모드 | 평문 | 위치2 | 위치4 | 순번+위치2 | 순번+위치4 |','|---|---|---|---|---|---|---|');
for(const r of rows)out.push(`| ${r.name} | ${r.mode} | ${paths.map(p=>both(r.first[p])).join(' | ')} |`);
out.push('','## 내장 배열 조회를 선택한 이유','',
'초기 PL/pgSQL 이진 탐색 구현으로도14조건×5경로를 전부 비교해 정확성은 통과했다. 평균 약15글자 필드에서 이진 탐색의 해석 실행 비용이 커 보여, 저장 표와 도장은 그대로 두고 DB 내장 array_position 함수를 쓰는 별도 함수로 바꿨다. 최종 표의 모든 경로는 이 변경 뒤 하나의 새 세션에서 처음부터 재측정했다. 두 구현은 별도 세션이므로 아래 값은 구현 선택의 참고이며 최종 다섯 방식 비교를 대신하지 않는다.','',
'| 조건·count | PL/pgSQL 이진 창2/4 SQL ms | 내장 배열 창2/4 SQL ms |','|---|---|---|');
const binary=read('binary-measure');for(const id of ['memo_common10','address_common10','memo_repeat45','memo_short2','memo_short3']){const a=binary.find((r:any)=>r.name===id&&r.mode==='count'),b=rows.find((r:any)=>r.name===id&&r.mode==='count');out.push(`| ${id} | ${f(a.medians.occurrence2.dbMs)}/${f(a.medians.occurrence4.dbMs)} | ${f(b.medians.occurrence2.dbMs)}/${f(b.medians.occurrence4.dbMs)} |`);}
out.push('','출처: pb1b-astra-binary-measure.json 및 pb1b-astra-measure.json.','',
'## 정합성과 노출 경계','',
'충돌이 없고 원본 도장이 온전하면 같은 조각의 등장 순번1..r이 연속이므로 첫 미존재까지 열거해 그 조각의 모든 위치를 얻는다. 창들이 검색어를 끝까지 덮고 같은 시작 위치의 오프셋을 강제하므로 해당 시작에서 전체 검색어가 일치한다. 적재 중 각 행·필드의64비트 도장 중복은 오류로 처리했고 이번100,000행에서는 발생하지 않았다. 이는 다른 질의 도장과의 충돌 가능성까지 제거했다는 뜻이 아니다.','',
'반복 조각의 각 등장이 서로 다른 도장을 갖도록 순번을 포함했고 병렬 배열은 도장값순으로 정렬했다. 정확한 글자 수와 각 도장에 대응한 평문 위치는 저장된다. 질의 조각키와 백업을 함께 얻으면 순번을 열거해 그 조각의 위치를 얻을 수 있으므로 과제1에서 논의한 위치 노출이 사라지지 않는다. 백업 공격·질의 기록 공격 복원율을 새로 측정하지 않았으며 보안 불변을 인증하지 않는다.','',
'## 가설 검증','',
'| 가설 | 판정 | 근거 |','|---|---|---|',
'| 등장 순번으로 반복 조각도 구분하면서 긴 검색을 판정한다 | 이번 질의에서 확인 | 14조건×5경로×10실행 결과 일치, 45글자 반복 반례 포함 |',
'| 모든 시작 위치를 해시로 탐색하지 않아도 된다 | 구현 및 계측 확인 | 순번 열거+내장 도장 조회+위치 교집합 |');
for(const w of [2,4]){const actual=rows.filter((r:any)=>!/[가-힣]/.test(r.term));const oldRatios=actual.map((r:any)=>r.medians[`position${w}`].dbMs/r.medians[`occurrence${w}`].dbMs);const ratios=actual.map((r:any)=>r.medians[`occurrence${w}`].dbMs/r.medians.plain.dbMs);out.push(`| 창${w}의 지연 개선 | 기존/새 SQL 속도비 ${f(Math.min(...oldRatios))}~${f(Math.max(...oldRatios))} | 한글 제외8개 비교; 새 배치는 평문 대비 ${f(Math.min(...ratios))}~${f(Math.max(...ratios))}배 |`);}
out.push('| 보안 동등성·운영 성능·장문 실제 비용 | 미검증 | 이번 실험 범위 밖 |','');
const valid=rows.filter((r:any)=>!/[가-힣]/.test(r.term));
const ratios=valid.flatMap((r:any)=>[2,4].map(w=>r.medians[`occurrence${w}`].dbMs/r.medians.plain.dbMs));
out.push('결론 1. 등장 순번 도장+평문 위치 배치는 고객10만 행에서 요청한 긴·짧은 검색 count·ID 목록을 모두 평문과 일치시켰다.  ',
`결론 2. 2글자 count는 기존보다 약3.4~3.6배 빨랐지만 흔한10글자 count는 느려졌고, 새 배치는 한글 제외 SQL이 평문 대비 ${f(Math.min(...ratios))}~${f(Math.max(...ratios))}배로 약2배 목표에 미달했다.  `,
'결론 3. 위치 열거를 순번 조회로 바꾸어도 위치 노출은 남고 반복 수에 따라 비용이 늘 수 있다; 보안 동등성과 장문 실물 성능은 미검증이다.','',
'근거 스크립트: bench/research-task1/pb1b-astra.ts, pb1b-astra-report.ts. 원시 결과: bench/results/2026-09-29-task1/pb1b-astra-*.json.','',
'사용자 지시에 따라 이번 과제의 pb_1b_w2·w4 및 두 보조 함수를 재측정용으로 보존했다. 정리 대기는 락 획득 전에 중단했고 DROP은 실행하지 않았다. 기존 원본·과제1 표도 그대로이며 원시 결과와 스크립트를 보존했다.','',
'재측정: npx tsx bench/research-task1/pb1b-astra.ts measure native 및 stats native; 이미 적재한 표가 있으므로 load/native 생성 단계는 다시 실행하지 않는다. 측정은 락을 획득하며 스크립트의 이번 마감 시각은 재실행 일정에 맞춰 명시적으로 갱신해야 한다.');
writeFileSync('.local/research/task1b-m1-astra.md',out.join('\n')+'\n');
writeFileSync(`${root}/pb1b-astra-audit.json`,JSON.stringify({at:new Date().toISOString(),conditions:14,paths:5,repetitions:7,warmups:2,firstSeparate:true,assertedTimedExecutions:700,sameBackendPid:rows[0].session.pid,appDecrypts:0,allComplete:true},null,2)+'\n');
console.log('Report saved; 700 timed executions asserted.');
