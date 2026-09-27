# V1. Drizzle 네이티브 API 정확성 검증

2026-09-27. 일회용 PostgreSQL `127.0.0.1:56439`에서 원본 `bench_realistic_100k`는 읽기만 하고, 공개 `sealed.insert`로 파생·재암호화한 `native_verify_main` 고객·티켓 각 10만 행을 검증했다. 각 DB 스크립트는 `assertDisposable`과 포트 확인 뒤 실행했다. 제품 `src/`는 수정하지 않았다.

| 검증 | 결과 | 근거 |
|---|---|---|
| 무작위 검색·count | 통과 | [search.json](search.json): 시드 21027, 원본 10만 행의 2~6글자 부분 문자열 단일/AND/OR 질의 2,664회 시도 중 결과 150행 이하 1,000개를 검증했다. 1,664개 넓은 질의는 사전 제외했다. 모든 질의에서 37행 페이지 커서를 끝까지 순회했고 ID·순서·암호화된 6개 필드 값·정확한 `number` count가 원본 평문 계산과 일치했다. |
| 넓은 커서·count | 통과 | `address.contains('세종대로')` 16,574행/448페이지, `company.contains('서울서비스')` 30,101행/814페이지를 끝까지 순회했다. 전 행의 ID·순서·6개 필드 값과 count가 평문과 일치했다. `maxCandidates:1`은 `LIMIT_EXCEEDED`를 던졌다. |
| 혼합·JOIN·관계형 읽기 | 통과 | [extra.json](extra.json): `m.sql` OR 20행, 1:N `sealed.search` 50행의 ID·순서·필드 값이 평문과 일치했다. Drizzle 관계형 `findMany({with:{tickets:true}})` 결과를 `sealed.open`으로 열어 고객 필드와 연결된 티켓 ID를 확인했다. |
| 인증·입력 거부 | 통과 | [integrity.json](integrity.json): 다른 행·scope로 옮긴 암호문, 마지막 바이트 변조, 틀린 키는 `AUTHENTICATION_FAILED`; 행 ID나 scope가 빠진 `open`/`openRaw`는 거부됐다. |
| 관리형 쓰기 | 통과 | 원본 5행의 값과 ID에서 파생한 별도 `probe` 테이블에서 insert·배열 insert·upsert·부분 update·null 왕복·트랜잭션 롤백 후 읽기와 검색을 확인했다. 테스트 후 `probe` 행은 삭제했다. |
| 동시성 §10.18 | 통과 | 같은 행의 같은 필드 update, 서로 다른 필드 update, update 대 delete, reindex 대 update 경합 뒤 영향 행을 전수 열어 공개 `searchPieces`·`searchTokens`로 재계산한 토큰과 보조 테이블의 두 필드 토큰 배열을 비교했다. 차이 0건이며 삭제 행의 보조 행도 0건이었다. |

옛 엔진 [V1 기록](../../2026-09-27-core-verification/v1/report-ko.md)의 같은 시드 무작위 검증도 2,664회 시도·1,000개 통과였다. 이번에는 기존 기록에서 미실행이었던 넓은 결과의 전체 커서 순회를 새 API에서 실행했으며, `sealed.search`와 관계형 `open`도 직접 검증했다. 커서 순회 중 동시 쓰기나 여러 요청 사이의 단일 스냅샷 보장은 측정하지 않았다. 이 결과는 로컬 파생 fixture에 대한 정확성 증거이며 운영 보장이나 보안 인증이 아니다.

재현: `rtk proxy node --import tsx bench/verify-native/v1-search.ts`, `v1-extra.ts`, `v1-integrity.ts`를 프로젝트 루트에서 실행한다. 마지막 스크립트는 `probe`가 비어 있어야 시작한다.
