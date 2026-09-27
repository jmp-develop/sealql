import { readFile, writeFile } from 'node:fs/promises';
const dir='bench/results/2026-09-27-native-verification/v3';
const old=await readFile('bench/results/2026-09-27-core-verification/v3/report-ko.md','utf8');
const matrix=JSON.parse(await readFile(`${dir}/matrix.json`,'utf8')).report;
const count=JSON.parse(await readFile(`${dir}/count.json`,'utf8'));
const join=JSON.parse(await readFile(`${dir}/join.json`,'utf8'));
const mixed=JSON.parse(await readFile(`${dir}/mixed.json`,'utf8'));
const write=JSON.parse(await readFile(`${dir}/write.json`,'utf8'));
const batch=JSON.parse(await readFile(`${dir}/write-batch.json`,'utf8'));
const ordinary=JSON.parse(await readFile(`${dir}/ordinary.json`,'utf8'));
const before=JSON.parse(await readFile(`${dir}/matrix-before-vacuum.json`,'utf8')).report;
const after=JSON.parse(await readFile(`${dir}/matrix-after-vacuum.json`,'utf8')).report;
const ginBefore=JSON.parse(await readFile(`${dir}/gin-before.json`,'utf8'));
const ginAfter=JSON.parse(await readFile(`${dir}/gin-after.json`,'utf8'));
const joinPre=JSON.parse(await readFile(`${dir}/join-pre-fix.json`,'utf8'));
const writeTrace=JSON.parse(await readFile(`${dir}/write-roundtrip.json`,'utf8'));
const oldMap=new Map();
for(const line of old.split('\n')){
  const m=line.match(/^\| ([a-z][a-z0-9_]+) \| ([\d.]+) \/ ([\d.]+) \| ([\d.]+) \/ ([\d.]+) \|/);
  if(m)oldMap.set(m[1],{plainTotal:+m[2],plainSql:+m[3],productTotal:+m[4],productSql:+m[5]});
}
const excluded=new Set(['sub_rare','sub_long','sub_zero','and4','drain101','word_boundary','word_inside_longer']);
const f=x=>Number(x).toFixed(2),pair=x=>`${f(x.totalMs)} / ${f(x.sqlMs)}`;
const rows=matrix.map(x=>{
  const o=oldMap.get(x.case);if(!o)throw Error(`missing old case ${x.case}`);
  const p=x.summary.plain,e=x.summary.product,sqlRatio=e.sqlMs/p.sqlMs,totalRatio=e.totalMs/p.totalMs;
  return `| ${x.case} | ${pair(p)} | ${pair(e)} | ${f(sqlRatio)}× / ${f(totalRatio)}× | ${f(o.productSql)} / ${f(o.productTotal)} | ${e.candidates} / ${e.returned} / 미계측 | ${excluded.has(x.case)?'C 로캘 등 판정 제외':sqlRatio<=2?'SQL 2배 이내':'SQL 2배 초과'} |`;
});
const classified=matrix.filter(x=>!excluded.has(x.case));
const within=classified.filter(x=>x.summary.product.sqlMs/x.summary.plain.sqlMs<=2).length;
const historical={exact_mid:'113.92 / 20.88',sub_rare:'7.79 / 1.45',zero:'1.62 / 0.84',
  join_rare:'32.58 / 3.80',join_broad:'28.45 / 2.47',join_zero:'2.87 / 1.43',
  mixed:'45.33 / 30.58'};
const oldWrite={insert:'5971.82 / 664.63',update:'1924.81 / 547.73',delete:'419.47 / 179.76'};
const other=(name,items)=>['| 사례 | 평문 전체 / SQL ms | 네이티브 전체 / SQL ms | 옛 엔진 기록값 제품 전체 / SQL ms | SQL 배율 | 반환 |','|---|---:|---:|---:|---:|---:|',
  ...items.map(x=>`| ${x.case??name} | ${pair(x.summary.plain)} | ${pair(x.summary.product)} | ${historical[x.case??name]??'—'} | ${f(x.summary.product.sqlMs/x.summary.plain.sqlMs)}× | ${x.expected??x.summary.product.returned} |`) ].join('\n');
const writeRows=['insert','update','delete'].map(op=>`| ${op} | ${pair(write.summary.plain[op])} | ${pair(write.summary.product[op])} | ${oldWrite[op]} | ${f(write.summary.product[op].sqlMs/write.summary.plain[op].sqlMs)}× |`).join('\n');
const findCase=(list,name)=>list.find(x=>x.case===name)??(()=>{throw Error(`missing ${name}`)})();
const followupRows=before.map(b=>{const a=findCase(after,b.case),o=oldMap.get(b.case);
  return `| ${b.case} | ${f(b.summary.plain.sqlMs)} / ${f(a.summary.plain.sqlMs)} | ${f(b.summary.product.sqlMs)} / ${f(a.summary.product.sqlMs)} | ${f(o.productSql)} | ${f(b.summary.product.totalMs)} / ${f(a.summary.product.totalMs)} |`;}).join('\n');
const nativeBefore=ginBefore.targets.find(x=>x.schema==='native_verify_main');
const nativeAfter=ginAfter.targets.find(x=>x.schema==='native_verify_main');
const oldGin=ginBefore.targets.find(x=>x.schema==='bench_standard_next_100k');
const ginIndex=x=>x.indexes.find(i=>/using gin/i.test(i.indexdef));
const mib=x=>f(x/1048576);
const initialJoin=findCase(joinPre,'join_broad').summary.product;
const finalJoin=findCase(join,'join_broad').summary.product;
const md=`# V3. Drizzle 네이티브 API 성능 검증

2026-09-27. 일회용 PostgreSQL 127.0.0.1:56439의 원본 \`bench_realistic_100k\` 고객·티켓 각 10만 행을 읽기만 하고, 공개 \`sealed.insert\`로 \`native_verify_main\`에 같은 값과 ID를 재암호화했다. \`drizzle-kit generate\`+\`migrate\`, \`extraMigrationSql\`, \`ANALYZE\`를 적용했다. 여섯 필드에 exact와 건너뜀·단어 경계 포함 substring을 설정했고 보조 테이블에는 여섯 substring 열의 다중 컬럼 GIN 하나가 있다. 평문과 제품은 같은 원본 값·질의·투영·정렬·limit를 썼다. 정렬은 평범한 UUID 행 식별자이고 암호 필드는 정렬 기준이 아니다. 아래 21개 검색 표는 VACUUM 전 최초 기준 측정이며, 바로 뒤에 색인 상태와 VACUUM 전후 결과를 기록한다.

모든 시간 표는 예열 2회 뒤 평문·네이티브 순서 교차 7회, 지표별 중앙값(ms)이다. SQL은 클라이언트의 pg 요청~응답 합계이며 서버 실행 시간만이 아니다. 전체는 API 호출 시간이다. 후보는 SQL 결과 행 수 합계로 관찰했으며 인증 복호화 필드는 공개 API 외부에서 정확히 계측하지 못해 **미계측**이다. 최초 실행과 매 반복에서 ID 순서와 여섯 필드 값을 평문과 비교했다. 옛 엔진은 삭제되어 재실행할 수 없어 아래 수치는 **옛 엔진 기록값**으로 표시한다. 출처: [matrix.json](matrix.json), [옛 엔진 기록](../../2026-09-27-core-verification/v3/report-ko.md).

## 21개 검색

| 사례 | 평문 전체 / SQL ms | 네이티브 전체 / SQL ms | 네이티브 SQL / 전체 배율 | 옛 엔진 기록값 제품 SQL / 전체 ms | 후보 / 반환 / 인증 필드 | 판정 |
|---|---:|---:|---:|---:|---:|---|
${rows.join('\n')}

SQL 기준 판정 대상 ${classified.length}개 중 ${within}개가 평문 대비 2배 이내, ${classified.length-within}개가 초과했다. C 로캘의 한글 LIKE 전체 스캔 또는 평문 단어 필터가 개입한 7개는 배율 판정에서 제외했다. 제외 사례의 빠른 제품 시간은 성능 우위 주장으로 쓰지 않는다.

옛 엔진 기록보다 느린 사례 중 \`sub_name_suffix\`, \`or3\`, \`and6\`을 [별도 EXPLAIN](matrix-explain.json)으로 확인했다. 모두 측정 반복당 SQL은 1회였고 추가 왕복은 없었다. 별도 실행에서 세 사례의 서버 실행 시간은 각각 1.46/1.42/8.88ms였으며 다중 컬럼 GIN을 사용했다. \`sub_name_suffix\`와 \`or3\`의 GIN 스캔은 공유 버퍼 hit 447블록, \`and6\`은 hit 758블록·약 7.32ms가 주요 구간이었다. EXPLAIN은 반복 중앙값이 아닌 독립 실행이다.

## GIN 상태와 VACUUM 전후

출처: [VACUUM 전 상태](gin-before.json), [VACUUM 후 상태](gin-after.json), [전 8사례](matrix-before-vacuum.json), [후 8사례](matrix-after-vacuum.json). \`pgstattuple.pgstatginindex\`로 pending list를 읽었고, 원본 및 옛 보조 테이블은 읽기만 했다. 새 고객 부모·보조 테이블에만 \`VACUUM (ANALYZE)\`를 실행했다.

| 보조 테이블 상태 | 새 테이블 전 | 새 테이블 후 | 옛 엔진 보조 테이블 |
|---|---:|---:|---:|
| GIN 크기 MiB | ${mib(ginIndex(nativeBefore).bytes)} | ${mib(ginIndex(nativeAfter).bytes)} | ${mib(ginIndex(oldGin).bytes)} |
| pending pages / tuples | ${nativeBefore.ginStats.pending_pages} / ${nativeBefore.ginStats.pending_tuples} | ${nativeAfter.ginStats.pending_pages} / ${nativeAfter.ginStats.pending_tuples} | ${oldGin.ginStats.pending_pages} / ${oldGin.ginStats.pending_tuples} |
| n_dead_tup 추정 | ${nativeBefore.stats.n_dead_tup} | ${nativeAfter.stats.n_dead_tup} | ${oldGin.stats.n_dead_tup} |
| 마지막 수동 VACUUM / ANALYZE | 없음 / 적재 후 1회 | 실행 / 실행 | 없음 / 없음 |

옛 테이블의 \`n_live_tup=0\`은 통계가 갱신되지 않은 카탈로그 추정치이며 실제 빈 테이블이라는 뜻이 아니다. 새 GIN 크기는 VACUUM 뒤에도 줄지 않았고 옛 GIN보다 컸다. 증분 적재가 남긴 pending list와 색인 물리 배치가 달라 최초 SQL 시간을 직접 동일한 물리 상태로 비교할 수 없었다.

| 사례 | 평문 SQL 전 / 후 ms | 네이티브 SQL 전 / 후 ms | 옛 엔진 기록값 SQL ms | 네이티브 전체 전 / 후 ms |
|---|---:|---:|---:|---:|
${followupRows}

옛 기록보다 느렸던 다섯 사례는 VACUUM 뒤 모두 개선됐다: \`sub_name_suffix\` ${f(findCase(before,'sub_name_suffix').summary.product.sqlMs)}→${f(findCase(after,'sub_name_suffix').summary.product.sqlMs)}ms, \`or3\` ${f(findCase(before,'or3').summary.product.sqlMs)}→${f(findCase(after,'or3').summary.product.sqlMs)}ms, \`and6\` ${f(findCase(before,'and6').summary.product.sqlMs)}→${f(findCase(after,'and6').summary.product.sqlMs)}ms 등이다. 같은 코드·데이터·질의에서 pending list가 425→0인 변화와 시간 감소가 같이 관찰되어 최초 차이의 주원인은 색인 상태로 판단한다. 캐시와 물리 배치도 동시에 달라졌으므로 이를 단독 인과 증명이나 운영 성능 주장으로 해석하지 않는다. 대표 세 사례도 표에 넣어 개선만 선택해서 보고하지 않았다.

## count, JOIN, mixed

count는 정확한 number와 평문 COUNT 일치, JOIN과 mixed는 ID 순서와 반환 필드 일치를 확인했다. JOIN은 티켓·고객 모두 네이티브 API를 썼다. 출처: [count.json](count.json), [join.json](join.json), [mixed.json](mixed.json).

${other('count',count)}

${other('JOIN',join)}

${other('mixed',[{case:'mixed',summary:mixed.summary}])}

count의 \`sub_rare\`·\`zero\`, JOIN의 \`join_rare\`·\`join_zero\`, mixed는 C 로캘 평문 전체 스캔 또는 복합 조건이 개입해 배율 판정에서 제외한다. \`exact_mid\` count의 네이티브 SQL은 20.24ms, 전체는 112.32ms로 평문보다 각각 24.40배, 121.97배 느렸다.

**JOIN 결함과 재검증:** 수정 전 \`join_broad\`는 네이티브 SQL 중앙값 ${f(initialJoin.sqlMs)}ms였다. [수정 전 EXPLAIN](join-explain-pre-fix.json)은 \`tickets\` 10만 행 Seq Scan→Sort→Merge Join 약 55ms를 보인다. 정렬 위치를 match 키 이름순으로 만들던 제품 결함은 별도 구현 커밋 \`f0d28e1\`에서 match 기재 순서로 수정됐다. 이 스크립트는 match를 \`{ t, c }\` 순으로 주며, 평문도 \`t.id\`로 정렬한다. 수정 후 예열 2회·교차 7회에서 네이티브 SQL 중앙값 ${f(finalJoin.sqlMs)}ms, 전체 ${f(finalJoin.totalMs)}ms였다. 옛 엔진 기록값은 SQL 2.47ms, 전체 28.45ms다. [수정 후 EXPLAIN](join-explain.json)은 서버 실행 0.48ms, 티켓 보조·부모 인덱스 주도 계획으로 10만 행 Seq Scan이 사라졌음을 보인다. 수정 전 결과는 [보존 파일](join-pre-fix.json)에 남겼다. EXPLAIN은 별도 실행이다.

## 쓰기와 일반 테이블

기존 원본 첫 1,000행의 같은 값과 ID를 격리 파생 테이블에 넣고 부분 수정·삭제했다. 단건 insert, 부분 update, delete는 단계마다 1,000건 합계 중앙값이다. 별도 1,000행 배치 insert도 같은 예열·교차 규칙이다. 출처: [write.json](write.json), [write-batch.json](write-batch.json).

| 연산 | 평문 전체 / SQL ms | 네이티브 전체 / SQL ms | 옛 엔진 기록값 제품 전체 / SQL ms | 전체 SQL 배율 |
|---|---:|---:|---:|---:|
${writeRows}
| insert 배치 1000 | ${pair(batch.summary.plain)} | ${pair(batch.summary.product)} | 직접 비교 없음¹ | ${f(batch.summary.product.sqlMs/batch.summary.plain.sqlMs)}× |

¹ 옛 엔진 배치 기록은 10,000행을 100행씩 넣은 다른 단위라 나란한 배율을 만들지 않았다. 새 배치는 1,000행 단일 호출이다.

**SQL 경계 보정:** 옛 엔진의 SQL 합계는 BEGIN/COMMIT을 제외한 데이터 문장만 계측했으나 이번 네이티브 전체 SQL 합계는 둘도 포함한다. 같은 경계로 맞춘 네이티브 데이터 SQL 중앙값은 insert ${f(write.summary.product.insert.dataSqlMs)}ms(옛 엔진 664.63ms), update ${f(write.summary.product.update.dataSqlMs)}ms(옛 엔진 547.73ms)다. 네이티브 트랜잭션 제어 SQL은 각각 ${f(write.summary.product.insert.txnSqlMs)}ms, ${f(write.summary.product.update.txnSqlMs)}ms로 측정됐다. 따라서 최초의 SQL 1.8배 차이는 대부분 계측 경계 차이다. 출처: [왕복 추적](write-roundtrip.json), [7회 기록](write.json). 단일 행 추적에서 평문 insert/update는 각 SQL 1회, 네이티브 insert/update는 BEGIN·부모 쓰기·보조 쓰기·COMMIT 총 4회였다. 부모 쓰기는 여섯 암호문 칸을 포함한 전체 행을 \`RETURNING\`했다. 보조 쓰기와 인증 암호화·토큰 계산은 계속 비용이며 각 요소의 단독 CPU 시간은 측정하지 않았다.

일반 테이블 select/insert는 두 Drizzle DB 핸들의 생성 SQL이 동일했다. 같은 프로세스에서 예열 2회·교차 7회 중앙값은 첫 핸들 ${f(ordinary.summary.beforeMs)}ms, 다른 핸들 ${f(ordinary.summary.afterMs)}ms다. SealQL은 Drizzle DB 핸들을 감싸지 않으며 SQL 차이는 0이었다. 두 핸들 모두 SealQL 모듈이 로드된 같은 프로세스에 있었으므로 이 시간은 import 자체의 전후 차이를 증명하지 않는다. 출처: [ordinary.json](ordinary.json).

## 판정과 한계

목표는 **평문 쿼리 SQL 시간 약 2배 이내**다. 위 대상 사례의 통과/초과를 그대로 기록한다. 인증 필드 수는 미계측이고, 후보 수는 여러 SQL 결과 행을 합산한 값이므로 중복 후보가 있으면 고유 후보 수와 다를 수 있다. 쓰기·검색은 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다. 재현 스크립트는 \`bench/verify-native/\`에 있다.
`;
await writeFile(`${dir}/report-ko.md`,md);
console.log(JSON.stringify({classified:classified.length,within,exceeded:classified.length-within}));
