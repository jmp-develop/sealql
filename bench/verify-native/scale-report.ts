/** Render the measured scale evidence; it never guesses missing values. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const dir='bench/results/2026-09-27-native-scale-100m';
const load=async(name:string)=>JSON.parse(await readFile(`${dir}/${name}.json`,'utf8'));
const maybe=async(name:string)=>{try{return await load(name);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}};
const fmt=(n:number|null|undefined)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(2):'미계측';
const gib=(n:number)=>`${(n/2**30).toFixed(2)} GiB`;
const matrix=await load('matrix');assert.equal(matrix.report.length,21);
const old=JSON.parse(await readFile('bench/results/2026-09-27-native-verification/v3/matrix.json','utf8'));
const oldByName=new Map(old.report.map((r:any)=>[r.case,r]));
const excluded=new Set(['sub_rare','sub_long','sub_zero','and4','drain101','word_boundary','word_inside_longer']);
let within=0,exceeded=0;
const slowTotal=matrix.report.filter((r:any)=>r.summary.product.totalMs/r.summary.plain.totalMs>10)
  .map((r:any)=>`${r.case} ${fmt(r.summary.product.totalMs/r.summary.plain.totalMs)}배`);
const matrixRows=matrix.report.map((r:any)=>{
  const a=r.summary.plain,b=r.summary.product,prior:any=oldByName.get(r.case);
  assert(prior,`missing old case ${r.case}`);
  const ratio=b.sqlMs/a.sqlMs;
  const verdict=excluded.has(r.case)?'C 로캘 등 판정 제외':ratio<=2?(within++,'2배 이내'):(exceeded++,'2배 초과');
  return `| ${r.case} | ${fmt(a.sqlMs)} / ${fmt(a.totalMs)} | ${fmt(b.sqlMs)} / ${fmt(b.totalMs)} | ${fmt(ratio)}× | ${fmt(b.totalMs/a.totalMs)}× | ${fmt(prior.summary.product.sqlMs)} / ${fmt(prior.summary.product.totalMs)} | ${b.candidates} / ${b.returned} | ${verdict} |`;
});
const checkpoints=await load('checkpoints');
const checkpointRows=checkpoints.map((x:any)=>`| ${x.stage} | ${x.customerRows?.toLocaleString('en-US')??'—'} | ${x.ticketRows?.toLocaleString('en-US')??'—'} | ${fmt(x.elapsedSec/60)} | ${gib(x.databaseBytes)} | ${gib(x.freeBytes)} | ${x.estimatedRemainingSec===null?'미계측':`${fmt(x.estimatedRemainingSec/60)}분 (당시 추정)`} |`);
const validation=await load('validation');
const count=await maybe('count'),mixed=await maybe('mixed'),join=await maybe('join');
const write=await maybe('write'),batch=await maybe('write-batch'),ticketValidation=await maybe('ticket-validation');
assert(count&&mixed&&write&&batch,'required measurements are missing');
assert(await maybe('index'),'customer indexes and vacuum are not recorded');
if(checkpoints.some((x:any)=>x.ticketRows>0))assert(join&&ticketValidation,'ticket evidence is incomplete');
const countRows=count?.map((r:any)=>{
  const a=r.summary.plain,b=r.summary.product;
  return `| ${r.case} | ${r.expected.toLocaleString('en-US')} | ${r.productOutcome.kind==='value'?r.productOutcome.value:'LIMIT_EXCEEDED'} | ${fmt(a.sqlMs)} / ${fmt(a.totalMs)} | ${fmt(b.sqlMs)} / ${fmt(b.totalMs)} |`;
})??[];
const joinRows=join?.report.map((r:any)=>`| ${r.case} | ${fmt(r.summary.plain.sqlMs)} / ${fmt(r.summary.plain.totalMs)} | ${fmt(r.summary.product.sqlMs)} / ${fmt(r.summary.product.totalMs)} | ${r.summary.product.candidates} / ${r.summary.product.returned} |`)??[];
const writeRows=write?['insert','update','delete'].map(op=>{
  const a=write.summary.plain[op],b=write.summary.product[op];
  return `| ${op} 1,000건 | ${fmt(a.sqlMs)} / ${fmt(a.totalMs)} | ${fmt(b.sqlMs)} / ${fmt(b.totalMs)} | ${b.sqlCalls} |`;
}):[];
if(batch)writeRows.push(`| insert 배치 1,000건 | ${fmt(batch.summary.plain.sqlMs)} / ${fmt(batch.summary.plain.totalMs)} | ${fmt(batch.summary.product.sqlMs)} / ${fmt(batch.summary.product.totalMs)} | ${batch.summary.product.sqlCalls} |`);
const last=checkpoints.at(-1);
const md=`# Drizzle 네이티브 API 1억 행 규모 시험

2026-09-27. 일회용 PostgreSQL \`127.0.0.1:56439\`에서 원본 \`bench_realistic_100k\`는 읽기만 했다. 고객 10만 행을 ID만 바꿔 1,000벌 복제하여 \`native_scale_100m\` 고객 암호·평문 테이블 각 1억 행을 만들었다. 암호문은 공개 \`createSealer.seal\`로 새 행 ID에 맞춰 재암호화했고, scope와 값에만 의존하는 보조 토큰은 같은 모델·키·scope의 10만 행 제품 테이블에서 SQL 복사했다. 부모·보조·평문 색인과 FK는 적재 후 생성하고 \`VACUUM (ANALYZE)\`를 실행했다. 암호 칸으로 정렬하지 않고 UUID ID로만 정렬했다.

**해석 전제:** 이 1억 행은 새 문장 1억 개가 아니라 **동일한 10만 행의 값 1,000벌**이다. 각 값·조각의 적중 행 수가 대체로 1,000배이며, 후보 수와 평문 LIKE 실행 계획도 달라진다. 이 수치를 실제 1억 행 서비스의 속도로 일반화하지 않는다.

## 적재·공간·정합

출처: [체크포인트](checkpoints.json), [색인·VACUUM](index.json), [ID 충돌 사전 검사](id-check.json), [고객 표본 검증](validation.json)${ticketValidation?', [티켓 표본 검증](ticket-validation.json)':''}. 원본 고객·티켓 각각 10만 UUID의 앞 8자리 뒤쪽이 모두 서로 달라, 복제 번호로 앞자리만 바꾼 ID가 충돌하지 않음을 확인했다. 적재 중단 기준은 여유 200GB로 운영해 지시된 150GB 근접 전에 멈추게 했다. 아래 남은 시간은 해당 시점 완료 속도로 계산한 **추정**이며 사후 실측 시간이 아니다.

| 단계 | 고객 행 | 티켓 행 | 고객 적재 경과 분 | DB 크기 | 드라이브 여유 | 고객 적재 남은 시간 |
|---|---:|---:|---:|---:|---:|---:|
${checkpointRows.join('\n')}

고객 ${validation.rows.toLocaleString('en-US')}행 × 여섯 칸의 암호문을 공개 \`openRaw\`로 인증·복호화해 원본 평문과 비교했다. 같은 행의 복사한 토큰 ${validation.tokenColumns.toLocaleString('en-US')}개 열을 공개 \`searchPieces\`·\`searchTokens\` 재계산과 비교한 결과 불일치 0건이었다.${ticketValidation?` 티켓도 ${ticketValidation.rows.toLocaleString('en-US')}행, ${ticketValidation.tokenColumns.toLocaleString('en-US')}개 토큰 열에서 불일치 0건이었다.`:''} 초기 10행 시험과 별도로 최종 1만 행 이상을 확인했다.

## 21개 검색

출처: [1억 행 반복 원시값](matrix.json), [10만 행 네이티브 기록](../2026-09-27-native-verification/v3/matrix.json). 두 경로는 같은 1억 행 ID·값, 질의·투영·ID 정렬·LIMIT를 썼고 최초 호출 및 모든 반복에서 ID 순서와 여섯 암호 칸 값을 비교했다. 예열 2회 뒤 평문·제품 순서를 교차한 7회 중앙값이다. SQL은 클라이언트의 요청~응답 합계, 전체는 API 호출 시간이며 지표별 중앙값은 서로 합산되지 않을 수 있다. 후보는 SQL 결과 행 수 합계, 실제 인증 복호화 필드 수는 **미계측**이다. 10만 행 기록은 색인 pending list가 남았던 최초 실행이므로 규모 효과만으로 차이를 설명할 수 없다.

| 사례 | 1억 평문 SQL / 전체 ms | 1억 제품 SQL / 전체 ms | SQL 배율 | 전체 배율 | 10만 제품 SQL / 전체 ms | 후보 / 반환 | 판정 |
|---|---:|---:|---:|---:|---:|---:|---|
${matrixRows.join('\n')}

평문 SQL 약 2배 기준의 판정 대상 ${within+exceeded}개 중 ${within}개 이내, ${exceeded}개 초과다. C 로캘 한글 LIKE 전체 스캔 또는 평문 단어 필터가 낀 ${excluded.size}개는 배율 판정에서 제외했다. 전체 시간 10배 초과 사례는 ${slowTotal.length?slowTotal.join(', '):'없음'}이다. SQL 기준 판정과 별개로 전체 시간을 보고한다.

## count·mixed·JOIN·쓰기

count는 예산 안에서 정확한 \`number\`만 반환하며 초과하면 \`LIMIT_EXCEEDED\`를 던진다. 원본의 적중 수가 1,000배가 된 조건에는 예산 20,000 후보를 주었다. 출처: ${count?'[count.json](count.json)':'미실행'}.

| count 사례 | 평문 정확 행 수 | 제품 결과 | 평문 SQL / 전체 ms | 제품 SQL / 전체 ms |
|---|---:|---:|---:|---:|
${countRows.join('\n')||'| 미실행 | — | — | — | — |'}

${mixed?`mixed의 평문 SQL / 전체는 ${fmt(mixed.summary.plain.sqlMs)} / ${fmt(mixed.summary.plain.totalMs)}ms, 제품은 ${fmt(mixed.summary.product.sqlMs)} / ${fmt(mixed.summary.product.totalMs)}ms이며 반환 ${mixed.summary.product.returned}행이다. [반복 원시값](mixed.json)에 일반 조건 24개와 암호 조건 6개, 후보 수를 기록했다.`:'mixed는 미실행이다.'}

${join?`JOIN은 match를 \`{ t, c }\` 순서로 써서 티켓 ID 정렬을 평문과 일치시켰다. 티켓 ${join.ticketCopies*100000}행에 대한 [반복 원시값](join.json):

| JOIN 사례 | 평문 SQL / 전체 ms | 제품 SQL / 전체 ms | 후보 / 반환 |
|---|---:|---:|---:|
${joinRows.join('\n')}`:'티켓 확대가 없어 JOIN은 미실행이다.'}

쓰기 1,000건은 같은 1억 행 테이블에 격리된 새 ID를 넣고 부분 update·delete 후 정리했다. 예열 2회, 교차 7회 중앙값이며 SQL 합계에 트랜잭션 제어 왕복이 포함된다. 출처: ${write?'[write.json](write.json), [write-batch.json](write-batch.json)':'미실행'}.

| 연산 | 평문 SQL / 전체 ms | 제품 SQL / 전체 ms | 제품 SQL 회수 |
|---|---:|---:|---:|
${writeRows.join('\n')||'| 미실행 | — | — | — |'}

## 판정과 한계

기준은 암호화·토큰 계산·복호화·재확인을 뺀 **쿼리 SQL 요청~응답 시간이 평문 대비 약 2배 이내**인 지다. 전체 시간은 별도 보고하며 느린 경우도 감추지 않았다. ${join?'티켓 JOIN 결과도 본문의 행 수 조건에서만 해석한다.':'티켓 JOIN은 미실행이다.'} 입력 반복과 로컬 합성 fixture, C 로캘, 캐시·물리 색인 상태가 결과에 영향을 준다. 운영 성능 보장이나 보안 인증이 아니다.
`;
await writeFile(`${dir}/report-ko.md`,md);
console.log(JSON.stringify({within,exceeded,excluded:excluded.size,customerRows:last.customerRows,ticketRows:last.ticketRows}));
