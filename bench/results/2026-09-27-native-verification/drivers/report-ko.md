# SealQL 드라이버·Workers 실사용 시험

> 보존 메모(코디네이터): 2026-09-27, 제품 커밋 `f0d37aa` 이전 상태(`4c78d5a` 전후)에서 Git 밖 임시 작업 폴더로 실행한 결과다. 시험 스크립트는 그 폴더에 있어 저장소에 보존되지 않았고 결과만 남긴다. 아래 neon-http 오류 코드 결함은 `4c78d5a`에서 `UNSUPPORTED_DRIVER`로 고쳐졌다. 실제 Cloudflare 배포(Hyperdrive 등)는 시험하지 않았다(로컬 workerd/miniflare만).

## 조건과 판정

- 일회용 PostgreSQL `127.0.0.1:56439`만 사용했다. 모든 DB 스크립트는 `assertDisposable`과 `show port` 확인 후 실행했다. 원본 fixture는 읽기만 했고, `native_scale_100m`은 건드리지 않았다.
- 패키지를 빌드한 뒤 `.local/drivertest`에만 드라이버와 패키지 이름 `sealql`을 설치했다. 제품 코드와 저장소 의존성은 수정하지 않았다. 시간은 측정하지 않았다.
- postgres-js 복사본의 원본 47개 사례 모두 통과했다. workerd 실제 DB 흐름도 통과했다. neon-http 쓰기는 문서의 오류 코드와 달라 제품 결함 후보 1건이다.
- `driver_test_app`, `driver_test_meta`는 매 시험 후 삭제했고 마지막 조회에서 `driver_test_%` 스키마 0개를 확인했다.

## postgres-js: 원본 47개 사례

원본 `.local/usage/usage.ts`를 복사했다. `drizzle-orm/postgres-js`와 `postgres`로 드라이버만 바꾸고, 원본과 충돌하지 않도록 스키마 이름만 `driver_test_*`로 바꿨다. `openRaw` 입력은 postgres-js `db.execute`의 배열 형태에 맞췄다. 각 실패 오류 원문 열의 `—`는 실패가 없음을 뜻한다.

| # | 사례 | 결과 | 실패 오류 원문 |
|---:|---|---|---|
| 1 | kit generate | 통과 | — |
| 2 | kit migrate | 통과 | — |
| 3 | extraMigrationSql | 통과 | — |
| 4 | kit push after migrate = no changes | 통과 | — |
| 5 | kit push again = no changes | 통과 | — |
| 6 | kit generate again = no new migration | 통과 | — |
| 7 | companion structure | 통과 | — |
| 8 | sealed.insert 3000 customers + 3000 orders | 통과 | — |
| 9 | open: full select with where/orderBy/limit | 통과 | — |
| 10 | open: partial select incl. id+tenantId | 통과 | — |
| 11 | open: partial select missing tenantId → ROW_CONTEXT_MISSING | 통과 | — |
| 12 | open: nested JOIN {c,o} | 통과 | — |
| 13 | open: LEFT JOIN with null side | 통과 | — |
| 14 | open: relational query with orders | 통과 | — |
| 15 | open: scope option mismatch → SCOPE_MISMATCH | 통과 | — |
| 16 | openRaw via db.execute | 통과 | — |
| 17 | findMany full traversal == plaintext, 126 traversals | 통과 | — |
| 18 | count == plaintext | 통과 | — |
| 19 | findMany where + orderBy + columns | 통과 | — |
| 20 | findMany rejects 1-char search | 통과 | — |
| 21 | findMany: other tenant scope never leaks | 통과 | — |
| 22 | search Drizzle JOIN, two-sided 1:N | 통과 | — |
| 23 | search one-sided 1:N keyset + page walk | 통과 | — |
| 24 | search raw db.execute + columns mapping | 통과 | — |
| 25 | sealed.update: sealed + plain columns together | 통과 | — |
| 26 | sealed.update memo → null | 통과 | — |
| 27 | update missing row / empty patch errors | 통과 | — |
| 28 | update wrong tenant → NOT_FOUND | 통과 | — |
| 29 | plain db.update ordinary column | 통과 | — |
| 30 | sealed.upsert existing/new/cross-tenant | 통과 | — |
| 31 | sealed.insert without id or nullable memo | 통과 | — |
| 32 | insert returning:true | 통과 | — |
| 33 | plain db.insert sealed plaintext → SEAL_REQUIRED | 통과 | — |
| 34 | plain Drizzle ciphertext rewrite → SEAL_REQUIRED | 통과 | — |
| 35 | transaction rollback, managed + plain | 통과 | — |
| 36 | transaction commit, managed + plain | 통과 | — |
| 37 | delete cascade and search exclusion | 통과 | — |
| 38 | scope-free insert/search/open | 통과 | — |
| 39 | ordinary table untouched | 통과 | — |
| 40 | relational nested sealed side | 통과 | — |
| 41 | explicit undefined properties | 통과 | — |
| 42 | search items contain no internal keys | 통과 | — |
| 43 | textId mixed-case/Korean traversal/index | 통과 | — |
| 44 | textId generated search SQL no COLLATE | 통과 | — |
| 45 | tampered ciphertext rejected | 통과 | — |
| 46 | moved ciphertext rejected | 통과 | — |
| 47 | damaged companion → reindex restores | 통과 | — |

추가 확인: `db.execute` 결과는 배열이고 `bytea` 값은 `Buffer`였다 (`00ff` → `[0,255]`). [raw-shape.ts](raw-shape.ts)로 재현할 수 있다. [outcome-postgres.ts](outcome-postgres.ts)는 commit 직후 응답 손실을 모의했고 `WRITE_OUTCOME_UNKNOWN`을 받으면서 행 1개가 실제 커밋된 것을 확인했다. 원본 47개 사례의 트랜잭션 안 관리형 쓰기도 통과했다.

## neon-http

| 사례 | 결과 | 오류 원문 |
|---|---|---|
| `drizzle(neon(...))`의 `sealed.insert` | 문서와 불일치 | SealQL `code=DATABASE_ERROR`, `message=DATABASE_ERROR`; 드라이버 원문 `No transactions support in neon-http driver` |
| `open` / `findMany` 등 조회 | 미시험 | 네트워크 연결이 필요한 드라이버 경로이므로 오프라인 시험에서 실행하지 않음 |

재현: [neon-http.ts](neon-http.ts). `native-runtime.ts`의 `checkedDb`는 `transaction` 함수 존재만 확인한다. neon-http는 함수를 제공하지만 호출 시 위 오류를 던지고, `sealed.insert`가 이를 `DATABASE_ERROR`로 바꾼다. 코디네이터에게 재현과 함께 보고했고 제품 코드 수정은 별도 구현자에게 맡겨졌다.

## Miniflare/workerd

| 사례 | 결과 | 오류 원문 |
|---|---|---|
| workerd `pg` + `pg-cloudflare`로 56439 TCP 연결 | 통과 | — |
| fixture 파생 행 `sealed.insert` | 통과 | — |
| Drizzle `select` + `sealed.open` | 통과 | — |
| `sealed.findMany` / `count` | 통과 | — |
| `sealed.update` 후 검색 | 통과 | — |
| Drizzle `delete` 후 count 0 | 통과 | — |

[workerd-host.ts](workerd-host.ts)가 `assertDisposable`, 포트, 스키마 설치와 정리를 맡고, [workerd-entry.ts](workerd-entry.ts)가 실제 workerd 내부에서 전체 흐름을 실행했다. 응답은 `{"status":200,"result":{"ok":true,"found":1,"count":1,"changed":1,"afterDelete":0}}`였다. 번들링에는 `workerd` 조건의 `pg-cloudflare`와 `nodejs_compat`가 필요했다. 처음에는 브라우저 번들의 Node 내장 모듈 해석 오류, 다음에는 ESM의 `Dynamic require of "events" is not supported`, 이어서 `unsupported require util/types`가 발생했으며 내장 모듈 매핑을 추가해 해결했다. 최종 실행에서는 오류가 없었다.

## 재실행

저장소 루트에서 `rtk npm run build` 후 아래 스크립트를 실행한다. 스크립트는 모두 `.local/drivertest` 안에 있으며, DB 접속 스크립트는 일회용 클러스터를 먼저 확인한다.

```text
rtk proxy node --import tsx .local/drivertest/usage-postgres.ts
rtk proxy node --import tsx .local/drivertest/neon-http.ts
rtk proxy node --import tsx .local/drivertest/workerd-host.ts
rtk proxy node --import tsx .local/drivertest/outcome-postgres.ts
rtk proxy node --import tsx .local/drivertest/raw-shape.ts
```

`neon-http.ts`는 현재 결함을 검출하므로 종료 코드 1이 예상된다.
