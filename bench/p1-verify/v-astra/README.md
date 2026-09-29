# P1 독립 검증

`load.ts`는 최종 HEAD를 빌드한 공개 `sealql`·`sealql/drizzle/v0.45` API로 보호 fixture의 원문 여섯 칸을 `test_p1_verify`에 적재한다. 일회용 클러스터/포트 검사를 먼저 수행하며, 기존 스키마가 있으면 중단한다. 4연결·500행 배치, 회사 exact2·나머지 기본16비트, substring 사용 설정이다.

```text
rtk proxy npm run build
rtk proxy node --import tsx bench/p1-verify/v-astra/load.ts --commit <HEAD>
```

결과는 `bench/results/2026-09-30-p1-verify/v-astra/`에 저장한다. `extraMigrationSql` 설치와 적재 후 `ANALYZE`, 부모/검색 표 각100000행, 첫100행의 원문600칸 인증 복호화를 단언한다. 시간은 진행 확인용이며 격리 성능 수치가 아니다.

`run.ts`는 평문 / 이전 제품7c14bda / 새 제품638f9c2를 동일 세션에서 비교한다. 이전 제품은 적재 시점 HEAD와7c14bda의 `src`·`package.json`·`tsconfig.json` 차이가 없음을 단언하고 빌드를 별도로 보존했으며, 파일 해시는 `baseline-build.json`에 기록한다. 실행에는 무시 경로의 보존 빌드가 필요하고 매 파일 해시를 확인한다. 새 빌드는 `new-build.json`에 기록한다. 두 공개 API의 `extraMigrationSql`이 같음을 단언한 뒤 같은 데이터와 함수에 각 빌드의 SQL을 적용한다.

```text
rtk proxy npm run build
rtk proxy npx tsx bench/p1-verify/v-astra/run.ts
rtk proxy npx tsx bench/p1-verify/v-astra/report.ts
```

측정 락 아래 단일 물리 연결, 첫 실행 분리·예열2·교차7회다. 세 경로는 홀수이므로 Williams 여섯 순서(ABC/BCA/CAB/CBA/ACB/BAC)를 모두 사용하고, 일곱 번째 순서는 조건마다 순환한다. 첫 여섯 회에서 각 방향의 선행 쌍이 두 번씩 등장함을 단언한다. 7회 전체가 완전 균형이라고 주장하지 않는다.

55 count + 55 목록300 + 단일 literal LIKE 목록 재확인3 + 일반 LIKE 목록2 + 전체목록3 = 118항목이다. 기본55조건에 literal LIKE3이 이미 있으므로 추가 재확인 결과는 구분한다. 매 호출마다 정규화 평문 oracle·목록 순서·반환 원문 여섯 칸을 비교하고 실제 인증 복호화 호출 수를 단언한다. SQL 왕복·전체 시간·SQL 횟수·전송 행 수·open 수는 따로 보존하며 내부 후보 행 수는 별도 실측하지 않는다. 부분 결과는 각 항목 완료마다 원자적으로 저장하고 정상·오류 모두 자기 측정 락을 해제한다.

`report.ts`는 완료된118항목만 보고서로 만들고 적재 보고는 별도 파일로 보존한다. 평균·중앙값·200ms/1초 초과 수·최악 악화와 조건별 SQL/전체 시간 표를 생성한다. 실제 결과는 [보고서](../../results/2026-09-30-p1-verify/v-astra/report-ko.md)에 있다. 로컬 합성 fixture의 순차 측정이며 운영 보장·보안 인증이 아니다.

`focus.ts`는 zero_and_common2 목록의 실제 SQL·파라미터 동등성, 경로별 EXPLAIN 및 기존 순서 추가7회를 기록한다. `plan-cache-diagnostic.ts`는 실제 드라이버 인자·prepared 목록, auto/force_custom_plan 각7회, 동일 SQL 직접 실행, custom/GENERIC_PLAN을 비교한다. `predecessor-diagnostic.ts`는 선행 평문 또는 제품 조회를 통제한 각 조합7회와 BUFFERS를 기록한다. 세 스크립트 모두 측정 락을 잡고 자기 소유 락을 해제한다. 완료 뒤 `report.ts`를 다시 실행하면 추가 절이 포함된다. 일반 측정 도구로 쓰기보다 이 결과를 재현하기 위한 고정 조건 스크립트다.

이 조건은 평문 직후 shared-buffer 재읽기가 두 제품 모두를 늦췄다. 회 내부 Williams 균형만으로 회 사이 연결과 추가7회차의 선행 캐시 상태까지 같아지지는 않는다. 전체 표는 원시 측정으로 보존하고 이 조건의 최초 악화를 P1 제품 변경으로 해석하지 않는다.
