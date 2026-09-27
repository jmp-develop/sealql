/** Render the Korean V3 report from recorded measurements; does not access DB. */
import { readFileSync, writeFileSync } from 'node:fs';
const dir='bench/results/2026-09-27-core-verification/v3';
const read=name=>JSON.parse(readFileSync(`${dir}/${name}.json`,'utf8'));
const detail=read('breakdown').report,mixed=read('mixed'),join=read('join'),count=read('count-detail'),write=read('write'),bulk=read('bulk');
const f=x=>Number(x).toFixed(2),ratio=(a,b)=>b?f(a/b):'—';
const localeScans=new Set(['sub_rare','sub_long','sub_zero','and4','drain101','word_boundary','word_inside_longer']);
const matrix=detail.filter(x=>!x.case.startsWith('sweep_')),sweep=detail.filter(x=>x.case.startsWith('sweep_'));
const eligible=matrix.filter(x=>!localeScans.has(x.case));
const passes=eligible.filter(x=>x.summary.product.totalMs<=2*x.summary.plain.totalMs);
const row=x=>{const p=x.summary.plain,q=x.summary.product,scan=localeScans.has(x.case);return `| ${x.case} | ${f(p.totalMs)} / ${f(p.sqlMs)} | ${f(q.totalMs)} / ${f(q.sqlMs)} | ${ratio(q.totalMs,p.totalMs)}× | ${q.candidates} / ${q.returned} / ${q.authenticatedFields} | ${scan?'C 로캘 평문 전체 스캔·제외':q.totalMs<=2*p.totalMs?'2배 이내':'2배 초과'} |`;};
const matrixRows=matrix.map(row).join('\n');
const sweepRows=sweep.map((x,i)=>{const c=read('sweep').chosen[i],p=x.summary.plain,q=x.summary.product;return `| ${c.term} | ${c.hits} | ${f(p.totalMs)} / ${f(p.sqlMs)} | ${f(q.totalMs)} / ${f(q.sqlMs)} | ${ratio(q.totalMs,p.totalMs)}× | ${q.candidates} / ${q.returned} / ${q.authenticatedFields} |`;}).join('\n');
const mixedJoin=[{name:'mixed 24 일반 + 6 암호 조건',value:mixed},...join.map(x=>({name:x.case,value:x}))];
const mixedJoinRows=mixedJoin.map(({name,value})=>{const p=value.summary.plain,q=value.summary.product,scan=name==='join_broad'?false:true;return `| ${name} | ${f(p.totalMs)} / ${f(p.sqlMs)} | ${f(q.totalMs)} / ${f(q.sqlMs)} | ${ratio(q.totalMs,p.totalMs)}× | ${q.candidates} / ${q.returned} / ${q.authenticatedFields} | ${scan?'평문 전체 스캔 또는 복합 조건·제외':'2배 초과'} |`;}).join('\n');
const countRows=count.map(x=>{const p=x.summary.plain,q=x.summary.product,scan=x.case!=='exact_mid';return `| ${x.case} | ${x.count} | ${f(p.totalMs)} / ${f(p.sqlMs)} | ${f(q.totalMs)} / ${f(q.sqlMs)} | ${ratio(q.totalMs,p.totalMs)}× | ${q.candidates} / ${q.authenticatedFields} | ${scan?'C 로캘 평문 전체 스캔·제외':'2배 초과'} |`;}).join('\n');
const breakdownRows=matrix.map(x=>{const q=x.summary.product;return `| ${x.case} | ${f(q.totalMs)} | ${f(q.sqlMs)} | ${f(q.openWallMs)} | ${f(q.remainderMs)} |`;}).join('\n');
const writeRows=['insert','update','delete'].map(k=>{const p=write.summary.plain[k],q=write.summary.product[k];return `| ${k} | ${f(p.totalMs)} / ${f(p.sqlMs)} | ${f(q.totalMs)} / ${f(q.sqlMs)} | ${ratio(q.totalMs,p.totalMs)}× | ${f(p.rowsPerSec)} / ${f(q.rowsPerSec)} |`;}).join('\n');
const bp=bulk.summary.plain,bq=bulk.summary.product;
const report=`# V3. 최종 제품 DDL 성능 검증

2026-09-27 · **검증 전용**. DB는 일회용 PostgreSQL \`127.0.0.1:56439\`이며 모든 DB 스크립트가 \`guard()\` → \`assertDisposable\`과 포트 확인을 먼저 실행했다. 읽기는 \`bench_realistic_100k\`의 평문 10만 행과 동일 행의 \`bench_standard_next_100k.customers_skip_product_multi\` 제품 DDL(건너뜀 기본 켬, 여섯 부분 검색 열에 다중 컬럼 GIN 하나)을 비교했다. mixed/JOIN 티켓은 기존 \`tickets_skip\`을 사용하고 고객은 제품 다중 컬럼 테이블을 사용한다. 쓰기 테이블은 기존 평문에서 복사·재암호화한 \`core_v3_*\` 격리 테이블이다. 원본과 제품 10만 행 fixture에는 쓰지 않았다.

모든 읽기·쓰기 표는 **예열 2회, 평문·제품 순서 교차 7회, 각 경로 중앙값**이다. 시간 단위는 ms이며 \`전체 / SQL\`은 클라이언트 요청 시작~결과와 SQL 요청~응답 합계다. 후보는 DB에서 받은 암호 후보 행, 인증 필드는 \`sealer.open\` 호출 횟수다. 평문 후보·인증 필드는 해당 없음이다. 각 경로의 결과 ID 순서와 여섯 필드 값은 최초 실행과 측정 7회에서 평문과 같았다. 중앙값은 지표별로 독립 계산하므로 열의 합이 정확히 맞지 않을 수 있다. 근거 파일은 각 표 아래에 적었다. 운영 보장이나 보안 인증이 아니다.

## 21개 검색 사례와 2배 판정

| 사례 | 평문 전체 / SQL | 제품 전체 / SQL | 전체 배율 | 제품 후보 / 반환 / 인증 필드 | 판정 |
|---|---:|---:|---:|---:|---|
${matrixRows}

판정 대상 ${eligible.length}개 중 **2배 이내 ${passes.length}개, 초과 ${eligible.length-passes.length}개**다. \`C\` 로캘의 한글·복합 \`LIKE\` 평문 전체 스캔 또는 \`respectWords\`의 평문 전량 필터가 개입한 ${localeScans.size}개는 사용자 지침에 따라 배율 판정에서 뺐다. 제외는 보안 검색의 승리 판정이 아니며, 실제 환경의 로캘과 색인에 따라 평문 기준이 달라진다. 20행 반환의 제품 경로는 흔히 후보 27행에서 조건 필드 27개와 반환 필드 120개 안팎을 인증하므로 SQL이 1ms 안팎이어도 전체가 7~9ms다. \`AND 6\`은 다중 조건의 후보 SQL ${f(matrix.find(x=>x.case==='and6').summary.product.sqlMs)}ms와 인증 ${matrix.find(x=>x.case==='and6').summary.product.authenticatedFields}회가 함께 비용을 키웠다.

출처: \`bench/standard-next/matrix.ts\`로 새 제품 테이블을 지정한 [matrix.json](matrix.json), 같은 질의를 계측한 [breakdown.json](breakdown.json). 평문 전체 스캔 분류는 기존 [SQL 계획 검증](../../2026-09-27-standard-next-sqlplan/report-ko.md)의 \`C\` 로캘 관찰과 이번 평문 시간에 근거한다. 이 실행에서 모든 평문 EXPLAIN을 다시 돌리지는 않았다.

## 주소 빈도 스윕

평문 적중 수는 10만 행 전체, 반환은 첫 페이지 20행(10건 조건은 10행)이다. 아래 배율은 참고값이며 로캘 전체 스캔 여부를 각 검색어마다 판정하지 않았다.

| 검색어 | 평문 적중 | 평문 전체 / SQL | 제품 전체 / SQL | 전체 배율 | 제품 후보 / 반환 / 인증 필드 |
|---|---:|---:|---:|---:|---:|
${sweepRows}

출처: 검색어·적중 수 [기존 제품 스윕](../../2026-09-27-product-multicolumn-gin/sweep.json), 이번 실행 [sweep.json](sweep.json) 및 [breakdown.json](breakdown.json). 같은 검색어·데이터·예열·교차 측정이다.

## mixed, JOIN, count

mixed는 24개 일반 컬럼 조건과 여섯 암호 조건을 함께 검사한다. JOIN의 고객은 새 제품 DDL, 티켓은 기존 skip fixture다. 둘은 제품의 공개 \`findMany\` 경로가 아니라 토큰 SQL + \`decryptRows\` 경로이므로 별도로 해석한다.

| 사례 | 평문 전체 / SQL | 제품 전체 / SQL | 전체 배율 | 제품 후보 / 반환 / 인증 필드 | 판정 |
|---|---:|---:|---:|---:|---|
${mixedJoinRows}

\`join_broad\`는 평문 ${f(join.find(x=>x.case==='join_broad').summary.plain.totalMs)}ms 대비 제품 ${f(join.find(x=>x.case==='join_broad').summary.product.totalMs)}ms다. 제품은 SQL ${f(join.find(x=>x.case==='join_broad').summary.product.sqlMs)}ms 후 후보 40행의 양쪽 여섯 필드, **480개 필드**를 인증한다. \`mixed\`도 후보 40행·240개 필드를 인증하지만 평문 복합 조건이 느려 배율에서 제외했다. 출처: [mixed.json](mixed.json), [join.json](join.json), \`bench/verify-core/v3-mixed.ts\`, \`v3-join.ts\`.

| count 사례 | 반환 건수 | 평문 전체 / SQL | 제품 전체 / SQL | 전체 배율 | 제품 후보 / 인증 필드 | 판정 |
|---|---:|---:|---:|---:|---:|---|
${countRows}

\`exact_mid\`는 한 번의 후보 SQL 뒤 1,770개 암호 필드를 인증하므로 평문 COUNT보다 크게 느리다. \`sub_rare\`·\`zero\`의 평문 \`LIKE\`는 이 \`C\` 로캘 fixture에서 느린 전체 스캔이다. 출처: [count-detail.json](count-detail.json), \`bench/verify-core/v3-count.ts\`. \`count.json\`은 기존 벤치의 별도 재실행이며 제품 경로는 \`skip\`으로 표기한다.

## 시간 구성

\`SQL\`은 DB 요청~응답 합계, \`복호화 wall\`은 겹치는 \`sealer.open\` 구간의 합집합 시간이다. \`잔여\`는 각 실행의 전체−SQL−복호화 wall로, **조건 재확인·토큰 준비·런타임/어댑터 작업을 함께 포함**한다. 조건 재확인만의 단독 시간은 측정 안 함이다. \`openCumulativeMs\`는 병렬 복호화 호출 시간을 단순 합산해 전체 wall보다 클 수 있으므로 아래 분해에는 쓰지 않았다.

| 사례 | 제품 전체 | SQL | 복호화 wall | 재확인 등 잔여 |
|---|---:|---:|---:|---:|
${breakdownRows}

출처: \`bench/verify-core/v3-sweep.ts\`가 제품 \`sealer.open\`을 계측한 [breakdown.json](breakdown.json). 계측 오버헤드가 포함되므로 \`matrix.json\`과 전체 시간이 약간 다르다.

## 관리형 단일 행 쓰기와 대량 적재

단일 행 쓰기는 기존 고객 첫 1,000행에서 파생한 동일 ID·동일 원문으로 plain과 제품에 각각 insert, 다음 **기존** 행의 메모로 부분 update, delete를 한 사이클에 실행했다. 제품은 공개 관리형 API와 새 제품 프로필·다중 컬럼 GIN을 사용한다. 평문 파생 테이블은 PK와 여섯 정규화 필드 B-tree를 가졌다. 표의 총 시간·SQL은 **1,000건 합계 중앙값**, 처리량은 행/초다. 제품 SQL 합계에는 암호화·HMAC 계산이 들어가지 않는다.

| 연산 | 평문 전체 / SQL | 제품 전체 / SQL | 전체 배율 | 평문 / 제품 행·초 |
|---|---:|---:|---:|---:|
${writeRows}

출처: [write.json](write.json), \`bench/verify-core/v3-write.ts\`. 제품 insert의 평문 대비 초과분은 여섯 필드 인증 암호화와 12개 검색 프로필의 토큰 생성, 부모·companion 관리와 트랜잭션 비용이 포함된다. 부분 update는 메모 필드만 재암호화·재색인하며 delete는 companion cascade를 사용한다. 어느 요소의 단독 CPU 시간인지는 측정 안 함이다.

대량 적재는 기존 10,000행을 100행씩 묶어 적재했다. 제품은 매 반복마다 여섯 필드를 \`Sealer.seal\`로 암호화하고 현재 프로필의 \`searchPieces/searchTokens\`를 만든 뒤 부모와 companion을 같은 트랜잭션에 넣었다. 평문은 같은 행의 평문·정규화 열을 100행 INSERT로 넣었다. 양쪽 모두 측정 내내 색인이 존재했다. 각 사이클 뒤 파생 테이블만 비웠고 원본에는 쓰지 않았다.

| 경로 | 10,000행 전체 ms | 준비 ms | SQL ms | 행/초 |
|---|---:|---:|---:|---:|
| 평문 | ${f(bp.totalMs)} | ${f(bp.prepareMs)} | ${f(bp.sqlMs)} | ${f(bp.rowsPerSec)} |
| 제품 | ${f(bq.totalMs)} | ${f(bq.prepareMs)} | ${f(bq.sqlMs)} | ${f(bq.rowsPerSec)} |

출처: [bulk.json](bulk.json), \`bench/verify-core/v3-bulk.ts\`. 대량 적재의 나머지 시간은 JavaScript 객체 생성·DB 전송·트랜잭션 호출 등이며 별도 분리 측정 안 함이다. 같은 머신·데이터·세션의 로컬 합성 fixture 결과로 운영 쓰기 보장은 아니다.

## 판정

| 영역 | 판정 | 근거와 남은 한계 |
|---|---|---|
| 21개 검색의 결과 일치 | 통과 | 최초·예열 후 교차 7회에서 ID 순서와 여섯 필드 값 일치. |
| 평문 대비 약 2배 이내 목표 | 결함 | C 로캘 평문 전체 스캔 제외 ${eligible.length}개 중 ${eligible.length-passes.length}개 초과. 제품 코드 수정은 하지 않았다. |
| mixed·JOIN·count 정확성 | 통과 | 동일 행/건수 단언. JOIN 티켓은 기존 DDL이고 두 조합은 공개 findMany 경로가 아니다. |
| 단일 행 쓰기·대량 적재 | 통과 | 격리 파생 테이블에서 각 1,000건 2회 예열·7회 교차, 대량 10,000행 100행 배치 2회 예열·7회 교차 완료. 처리량은 로컬 측정값. |
| 순수 재확인 시간 분리 | 한계(설계상) | 복호화 wall과 나머지는 측정했으나 나머지 안의 재확인만 분리하지 못했다. |

이 수치는 제품 변경을 제안하거나 성능 목표 달성을 보장하지 않는다. 특히 평문 색인 구성, \`C\` 로캘, JS 동시성, DB 캐시 상태가 바뀌면 배율도 달라진다.
`;
writeFileSync(`${dir}/report-ko.md`,report);
console.log(JSON.stringify({eligible:eligible.length,within2x:passes.length,excluded:localeScans.size,writeRatio:Object.fromEntries(['insert','update','delete'].map(k=>[k,+(write.summary.product[k].totalMs/write.summary.plain[k].totalMs).toFixed(2)])),bulkRowsPerSec:{plain:bp.rowsPerSec,product:bq.rowsPerSec}}));
