/** Append the R8c comparison and recorded measurement conditions to the R8 table. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const dir = 'bench/results/2026-09-28-r8-remeasure';
const read = async (name: string) => JSON.parse(await readFile(`${dir}/${name}`, 'utf8'));
const initial = await read('results.json');
const changed = await read('r8c-200.json');
const join = await read('join.json');
const db = await read('db-state.json');
const dbC = await read('r8c-db-state.json');
const joinDb = await read('join-db-state.json');
const audit = await read('or2-200-audit.json');
const old = JSON.parse(await readFile('bench/results/2026-09-27-native-scale-100m/scope-b/combo-results.json', 'utf8')).report;
assert.equal(initial.rows.length, 72);
assert.equal(changed.rows.length, 10);
assert.equal(join.length, 3);
assert.equal(initial.metadata.distBefore, initial.metadata.distAfter);
assert.equal(changed.metadata.distBefore, changed.metadata.distAfter);
for (const state of [db, dbC, joinDb]) for (const before of state.before.tables ?? state.before) {
  const after = (state.after.tables ?? state.after).find((x: any) => x.table === before.table);
  assert.deepEqual(after.reloptions, before.reloptions, `${before.table} reloptions`);
}
const fmt = (n: number) => Number(n.toFixed(2));
const metric = (x: any) => `${fmt(x.dbMs)} / ${fmt(x.totalMs)}`;
const oldRow = (name: string) => old.find((x: any) => x.case === name);
const c2 = (r: any) => initial.rows.find((x: any) => x.case === r.case && x.environment === r.environment && x.mode === 'findMany 200');
const r8cTable = changed.rows.map((r: any) => {
  const before = r.environment === '1억 속 회사 B' ? oldRow(r.case).find.product : null;
  const sql = r.runs.product.flatMap((x: any) => x.sqlEvents.map((e: any) => e.sql));
  const prefix = sql.length === 7 && sql.every((x: string) => x.includes('with sample as materialized'));
  assert(prefix, `${r.case}/${r.environment}: prefix path`);
  const sameOld = before ? oldRow(r.case).find.runs.product.flatMap((x: any) => x.sql ?? [])
    .every((x: string, i: number) => x === sql[i]) : null;
  if (before) assert.equal(sameOld, true, `${r.case}: SQL differs from R8 before`);
  const p = r.plain, x = r.product;
  return `| findMany 200 | ${r.condition} | ${r.environment} | ${r.matches} | ${r.returned} | ${x.candidateRows} | ${x.sqlCalls} | ${x.openCount} | ${metric(p)} | ${fmt(x.preMs)} / ${fmt(x.dbMs)} / ${fmt(x.betweenSqlMs)} / ${fmt(x.postMs)} / ${fmt(x.totalMs)} | ${fmt(x.openWallMs)} | ${before ? `${fmt(before.totalMs)} / ${fmt(before.sqlMs)}` : '없음'} | ${fmt(c2(r).product.totalMs)} / ${fmt(c2(r).product.dbMs)} | ${fmt(x.totalMs)} / ${fmt(x.dbMs)} | 예${sameOld === null ? '' : ' · SQL 동일'} |`;
});
const joinTable = join.map((r: any) => `| search JOIN 20 | ${r.condition} | 10만 단독 | ${r.matches} | ${r.returned} | ${r.product.candidateRows} | ${r.product.sqlCalls} | ${r.product.openCount} | ${metric(r.plain)} | ${fmt(r.product.preMs)} / ${fmt(r.product.dbMs)} / ${fmt(r.product.betweenSqlMs)} / ${fmt(r.product.postMs)} / ${fmt(r.product.totalMs)} | ${fmt(r.product.openWallMs)} | ${fmt(r.previous.totalMs)} / ${fmt(r.previous.dbMs)} | ${fmt(r.product.dbMs / r.plain.dbMs)} / ${fmt(r.product.totalMs / r.plain.totalMs)} |`);
const or2Before = oldRow('or2').find.product;
const or2Initial = initial.rows.find((r: any) => r.case === 'or2' && r.environment === '1억 속 회사 B' && r.mode === 'findMany 200');
const or2Now = changed.rows.find((r: any) => r.case === 'or2' && r.environment === '1억 속 회사 B');
const base = (await readFile(`${dir}/report-ko.md`, 'utf8')).split('\n## R8c 재측정')[0].trimEnd();
const add = `

## R8c 재측정

위 72행 표는 **c2fc645**에서 측정한 findMany 20(42행), findMany 200(10행), findMany 전부(10행), count(10행)이다. 아래 10행만 **fc561ac**에서 다시 측정했다. 예열 2회와 평문·제품 교차 7회, 매 실행 ID 순서·투영 값 일치를 적용했다. limit 미지정은 limit 속성을 보내지 않았고, 제품 호출에는 budgets·maxCandidates·deadline을 보내지 않았다. 전부 반환은 행 수와 ID 집합 SHA-256도 비교했다. 첫 측정 값과 7회 원시값은 JSON에 있다.

| 조회 방식 | 조건 전문 | 환경 | 실제 일치 | 결과 수 | DB 후보 수 | SQL 회수 | 인증 복호화 필드 수 | 평문 SQL / 합계 ms | 제품 전처리 / DB / SQL 사이 / 후처리 / 합계 ms | 복호화 wall ms | R8 전 합계 / DB ms | c2fc645 합계 / DB ms | fc561ac 합계 / DB ms | prefix 경로 |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|
${r8cTable.join('\n')}

회사 B 5사례의 fc561ac 제품 SQL 텍스트는 R8 전 저장된 각 실행의 SQL과 **문자 단위로 같다**. R8 전 파일에는 파라미터 값이 저장되지 않아 파라미터 동등성은 판정할 수 없다. fc561ac의 10사례 모두 7회 SQL에 with sample as materialized가 있으며, 각 실행은 SQL 1회다.

## 회사 B or2 회귀와 복원

findMany 200 조건은 **(company = "서울서비스 담당" OR memo contains "푸른달")**이다. DB 중앙값은 R8 전 ${fmt(or2Before.sqlMs)}ms, c2fc645 ${fmt(or2Initial.product.dbMs)}ms, fc561ac ${fmt(or2Now.product.dbMs)}ms였다. 합계 중앙값은 각각 ${fmt(or2Before.totalMs)}ms, ${fmt(or2Initial.product.totalMs)}ms, ${fmt(or2Now.product.totalMs)}ms였다.

c2fc645 SQL은 R8 전 SQL과 문자 단위로 다르다(첫 차이 위치 ${audit.differences[0].offset}; 1159자 대 524자). R8 전 budgets.batch 기본 200으로 첫 요청이 200행이어서 256행 prefix 경로를 탔다. c2fc645에서 그 기본값을 없애 첫 요청이 252행 직접 경로로 바뀌었다. fc561ac는 첫 요청의 prefix 경로를 복원했다. 이는 코드 변경과 SQL 텍스트로 확인한 회귀 및 복원이다.

c2fc645의 7회 DB 값은 ${audit.dbRuns.map((x: number) => fmt(x)).join(', ')}ms(최소 ${fmt(audit.dbMinMs)}, 최대 ${fmt(audit.dbMaxMs)}). 별도 EXPLAIN (ANALYZE, BUFFERS) 1회는 Limit→Sort→Nested Loop, 보조 Bitmap Heap Scan 28,400행과 부모 PK Index Scan 28,400회를 보였다. 루트 shared hit 151,751 / read 22,704블록, 실행 143.45ms였다. R8 전 계획은 기록되지 않아 **계획 동일/상이 판정은 불가**하다. buffer read가 시간에 기여했을 가능성은 추정이다. [SQL 차이·실행 계획](or2-200-audit.json).

## V3 JOIN 추가 측정

이 3건은 c2fc645에서 측정했으며 fc561ac에서는 재측정하지 않았다. 제품 SQL 텍스트는 V3와 세 사례 모두 문자 단위로 같고 각 1,548자이며 to_jsonb가 없다. 첫 페이지만 조회했으므로 커서의 후속 위치 인코딩 경로는 실행되지 않았다.

| 조회 방식 | 조건 전문 | 환경 | 실제 일치 | 결과 수 | DB 후보 수 | SQL 회수 | 인증 복호화 필드 수 | 평문 SQL / 합계 ms | 제품 전처리 / DB / SQL 사이 / 후처리 / 합계 ms | 복호화 wall ms | V3 합계 / DB ms | 평문 대비 DB / 합계 배율 |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|
${joinTable.join('\n')}

join_broad와 join_zero의 제품 DB 중앙값은 V3보다 각각 ${fmt(join[1].product.dbMs - join[1].previous.dbMs)}ms, ${fmt(join[2].product.dbMs - join[2].previous.dbMs)}ms 높았다. 별도 EXPLAIN은 join_broad에서 Limit→Incremental Sort→Nested Loop/Index Scan, shared hit 526/read 0블록(실행 0.419ms), join_zero에서 Limit→Sort→Nested Loop/Bitmap Heap Scan, hit 351/read 0블록(실행 0.760ms)을 보였다. V3 계획 기록이 없어 계획 동일/상이 판정은 불가하다. [JOIN 실행값](join.json), [JOIN 계획](join-explain.json).

## 실행 조건과 기록

- c2fc645 빌드 산출물 SHA-256은 측정 전후 ${initial.metadata.distBefore}로 같았다. fc561ac도 빌드 1회 뒤 측정 전후 ${changed.metadata.distBefore}로 같았다.
- 두 측정 모두 일회용 DB의 5개 대상 테이블 reloptions를 기록한 뒤 autovacuum을 일시 중지하고, 측정 뒤 원래 reloptions(null)로 복원했다. c2fc645의 취소 대상 autovacuum 백엔드는 준비 시점에 이미 없었다. 대상 GIN pending page는 전후 모두 0이었다. [첫 DB 상태](db-state.json), [R8c DB 상태](r8c-db-state.json).
- JOIN용 tickets와 tickets_seal_index도 reloptions를 기록·복원했다. tickets GIN pending page는 전후 335로 같았다. [JOIN DB 상태](join-db-state.json).
- 1억 스키마의 고객 보조 테이블은 수동 VACUUM 기록이 없고 마지막 수동 ANALYZE는 2026-09-27 19:49 UTC였다. 이번 측정에서 VACUUM·ANALYZE·GIN pending 정리를 실행하지 않았다. DB 상태 기록에 마지막 실행 시각과 통계가 있다.
- 두 환경의 21개 평문 조건 일치 수는 이전 보고값과 42/42 일치했다. 단어 경계 두 사례의 29,843은 단어 경계 재확인 **전** SQL 일치 수다. 전체 1억 행은 완료 복제 1,000개 × 회사 B 10만 행으로 확인했으며 1억 행 COUNT는 실행하지 않았다.
- c2fc645의 10만 단독 findMany 20 중 exact_mid·exact_one·exact_zero는 V3 제품 SQL 중앙값보다 20% 넘게 높았다. 절대 차이는 각각 0.191·0.168·0.095ms이며 별도 EXPLAIN의 shared read는 59·6·5블록이었다. 20% 기준은 이후 폐기되었고 회귀 판단에 사용하지 않았다. [첫 구간 계획](phase1-explain.json).
- 모든 수치는 로컬 합성 fixture 결과이며 운영 성능 보장·보안 인증이 아니다. C 로캘에서 한글 평문 LIKE 배율은 판정에서 제외한다. 지표별 중앙값이므로 구간 합과 합계가 일치하지 않을 수 있다.

[c2fc645 원시 실행값](results.json) · [fc561ac 200건 원시 실행값](r8c-200.json) · [느린 사례 계획](explain.json)
`;
await writeFile(`${dir}/report-ko.md`, base + add);
console.log(JSON.stringify({ initialRows: initial.rows.length, r8cRows: changed.rows.length, joinRows: join.length,
  restoredTables: db.after.tables.length + dbC.after.tables.length + joinDb.after.length,
  initialDist: initial.metadata.distAfter, r8cDist: changed.metadata.distAfter }));
