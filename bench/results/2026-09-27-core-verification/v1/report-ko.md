# standard 코어 V1 기술 검증

2026-09-27. 제품 `src/`는 수정하지 않았다. 모든 DB 작업은 `assertDisposable`과 포트 확인을 통과한 `127.0.0.1:56439`의 `.local/pg-test`에서 실행했다. `bench_realistic_100k`와 `bench_standard_next_100k.customers_skip_product_multi`는 읽기만 했고, 쓰기는 전자의 기존 행을 복사하거나 재암호화한 `bench_standard_next_100k.core_verify_probe`에서만 했다. 아래 판정은 이 로컬 fixture에만 적용되며 운영 보장이나 보안 인증이 아니다.

| 영역 | 판정 | 근거와 조건 | 남은 한계 |
|---|---|---|---|
| 10만 행 검색 | 통과 | [search.json](search.json): 새 제품 DDL의 6개 토큰 열을 포함하는 GIN 1개 확인. `eq`, `contains`, `startsWith`, `endsWith`, LIKE 접두·접미·중간, `respectWords`, 중첩 AND/OR, 정확+부분 혼합 10종의 전체 ID 목록과 `count`가 평문과 같았다. 각 질의는 37행 커서 페이지를 끝까지 순회했다. | 고정 사례는 1~3행의 희귀 조건이다. 넓은 조건의 전체 커서 순회는 실행하지 않았다. |
| 무작위 질의 | 통과 | [search.json](search.json): 시드 21027, 실제 10만 행 값의 정규화 문자열에서 2~6글자 부분 문자열을 뽑아 단일 조건 또는 무작위 AND/OR 조합 생성. 2,664회 시도 중 결과 150행 이하인 1,000개를 검증하여 거짓 음성·거짓 양성·커서 중복·누락 0건. 1,664개 넓은 질의는 사전 제외. | 질의는 `contains` 중심이며 넓은 결과 집합, 커서 중간의 동시 쓰기와 스냅샷 일관성은 검증하지 않았다. |
| count·예산 | 통과 | [search.json](search.json): 고정 10종의 평문 결과 수와 일치, `maxCandidates:1`은 `LIMIT_EXCEEDED`. | 10만 행 전체 건수나 높은 후보 수의 count는 실행하지 않았다. |
| mixed·JOIN | 통과 | [mixed.json](mixed.json), [join.json](join.json): 기존 벤치의 평문 비교를 복제해 `skip` 고객 경로를 새 제품 DDL 테이블로 지정. mixed는 20행, JOIN의 rare/broad/zero는 각각 20/20/0행으로 순서와 필드 값이 평문과 일치했다. 예열 2회·교차 7회도 실행했다. | JOIN 티켓 쪽은 기존 `tickets_skip` DDL이다. 두 벤치는 공개 `searchWithQuery` 호출이 아닌 토큰 SQL + `decryptRows` 경로다. JSON의 시간은 부수 기록이며 이 보고서는 성능 판정을 하지 않는다. |
| 입력 경계 | 통과 | [input.json](input.json): 빈 값·정규화 후 1글자는 `QUERY_TOO_BROAD`; NFC/NFD 한글, 전각 ASCII, 대소문자, 연속 공백 정규화가 일치. 2,049글자 조각 입력은 `LIMIT_EXCEEDED`. 메모리 암호화에서 `maxBytes:16`은 왕복 성공, 17바이트는 `LIMIT_EXCEEDED`. | 2,048글자 저장·검색 왕복, nullable 필드, DB 쪽 `maxBytes` 경계는 실행하지 않았다. |
| 암호문·키·커서 무결성 | 통과 | [integrity-write.json](integrity-write.json): 1바이트 변조, 행·필드 이동, 틀린 루트 키·모델 키는 거부; 변조 커서와 다른 질의 커서도 거부. | `repo.get`로 인증 실패를 관찰했다. 검색 페이지 안에서 변조된 후보를 만나는 경로는 별도로 실행하지 않았다. |
| 악의적 DB 누락 | 한계(설계상) | [integrity-write.json](integrity-write.json): 첫 행을 찾은 뒤 해당 companion의 `name/exact` 토큰을 NULL로 바꾸자 같은 검색에서 그 행이 오류 없이 빠졌다. 원래 토큰으로 복원했다. | 라이브러리는 DB가 후보를 감춘 사실을 검출하지 못한다. |
| 관리형 쓰기·동시성 | 통과 | [integrity-write.json](integrity-write.json): 기존 평문에서 파생한 insert 직후 검색, 부분 update 후 다른 필드 토큰 보존, 같은 행 동시 CAS 중 1개만 성공, 서로 다른 행 동시 update 성공, delete의 companion cascade를 확인했다. companion update를 강제로 실패시키는 트리거에서 부모 revision·암호문과 companion이 함께 롤백됐다. | 다수 클라이언트·장기 경합 부하와 운영 쓰기 성능은 측정하지 않았다. |
| 처음부터 적용하는 사용성 | 한계 | [integrity-write.ts](../../../verify-core/integrity-write.ts)는 raw 제품 DDL을 빈 파생 테이블에 적용하고 공개 관리형 API를 호출했다. `README.md`, `docs/llm-integration.md`, `examples/`를 읽고 `npm run docs:check`, `npm run check`가 통과했다. | Drizzle Kit로 빈 스키마 생성부터 실행하는 흐름, 공개 `searchWithQuery`의 JOIN/혼합 경로, 일반 컬럼과 암호 조건 사이의 OR 거부는 실행 재현하지 못했다. [결정 009](../../../../docs/decisions/009-scope-and-non-goals.md)의 알려진 한계로만 확인했다. |

## 재현

프로젝트 루트에서 `rtk proxy node --import tsx bench/verify-core/search.ts`, `input.ts`, `integrity-write.ts`, `mixed.ts`, `join.ts` 순으로 실행한다. `mixed.ts`와 `join.ts`는 삭제된 원본 벤치에서 생성한 파일이며, 생성 스크립트는 보존하지 않았다. 각 스크립트가 DB 소유와 주소를 먼저 확인한다. `search.ts`는 10만 평문 행을 메모리에 올려 정규화한 뒤 API 결과와 비교하므로 이 실행의 SQL 요청~응답 시간, 전체 시간, 후보·인증 필드 수는 **측정 안 함**이다. mixed/JOIN의 부수 시간값은 각각의 JSON에 조건과 함께 남겼다.

제품 결함은 이 범위에서 관찰되지 않았다. 미실행 항목은 통과로 해석하면 안 된다.

## V1 후속 검증과 최종 판정 (2026-09-27)

위 첫 표는 최초 실행의 범위를 보존한 기록이다. 아래는 그 뒤 남은 코어 항목을 검증한 최종 표다. DB 주소·소유 확인, `bench_realistic_100k` 읽기 전용, `src/` 무변경 원칙은 동일하다. 쓰기는 기존 행의 값과 암호문에서 파생한 격리 테이블 `core_verify_boundary`, `core_verify_candidate`, `core_verify_public_or`에서만 했다. SQL 요청~응답 시간, 전체 시간, 후보 수, 인증 복호화 필드 수는 이번 후속 실행에서 **측정 안 함**이며 성능 주장은 하지 않는다.

| 영역 | 최종 판정 | 입력·기대값·실제값과 출처 | 남은 한계 |
|---|---|---|---|
| 넓은 결과의 커서·count | 통과 | [wide.json](wide.json): 새 제품 DDL 10만 행에서 `address.contains('세종대로')` 16,574행/83페이지, `company.contains('서울서비스')` 30,101행/151페이지를 200행 페이지로 끝까지 순회했다. 평문 ID 순서의 SHA-256과 암호 검색 ID 순서의 SHA-256이 각 사례에서 같고 중복 0건이었다. `count`는 각각 16,574·30,101로 평문과 같았다. `maxCandidates:100`은 `LIMIT_EXCEEDED`. | 커서 순회 중 동시 쓰기·별도 요청 사이의 스냅샷 일관성은 측정하지 않았다. |
| nullable 필드 | 통과 | [boundary-db.json](boundary-db.json): 기존 행의 메모·이메일에서 파생한 행에 `optional:null`을 저장했다. `get`과 다른 암호 필드 검색의 반환값이 null이며 exact·substring 토큰 열도 NULL이었다. 부분 update로 기존 이메일 값을 넣은 뒤 exact 검색 1건·두 토큰 열 생성, 다시 null로 바꾼 뒤 이전 검색 0건·두 토큰 열 NULL, 무관한 body 검색 1건을 확인했다. | null 자체를 조건으로 하는 `eq(null)`은 지원 검색으로 가정하지 않았고 검증하지 않았다. |
| 2,048글자·DB maxBytes | 통과 | [boundary-db.json](boundary-db.json): 기존 메모의 정규화 문자열을 반복해 파생한 2,048문자(UTF-8 5,692바이트)를 insert하고 `get` 원문 및 중간 6글자 `contains` 1건이 일치했다. 2,049문자 부분 update는 `LIMIT_EXCEEDED`. `maxBytes:16` 필드에 기존 이메일에서 파생한 16바이트는 저장·정확 검색 성공, 17바이트 update는 `LIMIT_EXCEEDED`이며 revision과 이전 검색 결과가 보존됐다. | 매우 긴 값의 대량 적재·운영 비용은 측정하지 않았다. |
| 검색 페이지의 변조 후보 | 통과 | [candidate-tamper.json](candidate-tamper.json): 기존 2행을 복사하고 `company.contains('서울서비스')`, limit 1로 첫 페이지를 받았다. 다음 후보 행의 `company_ct` 마지막 1바이트를 뒤집고 companion은 그대로 둔 채 커서를 이어 검색하자 **`AUTHENTICATION_FAILED`**가 났다. 암호문 복원 후 같은 커서는 두 번째 행을 정상 반환했다. | 토큰 자체를 제거해 후보를 감춘 경우는 앞 절처럼 조용한 누락이다. |
| 일반 컬럼 OR 암호 조건 | 한계(설계상) | [public-or.json](public-or.json): 기존 2행에서 `body`를 암호 필드, `tag`를 일반 컬럼으로 저장했다. `body.eq(첫 행)`만은 첫 행, `where tag=둘째 이메일`만은 둘째 행이며 기대 OR은 두 행이다. `match`와 `where`를 같이 주면 AND로 처리되어 0행, `f.any(암호 조건, 일반 컬럼 SQL fragment)`는 `INVALID_VALUE`로 거부됐다. | `findMany`의 공개 표현식에 일반 컬럼과 암호 조건을 섞은 OR이 없다. 공개 `searchWithQuery` 경로는 Drizzle 통합 재설계([plan/001](../../../../plan/001-drizzle-native-api.md)) 대상으로 이번 후속 범위에서 제외했다. |
| 기존 고정·무작위·mixed/JOIN·관리형 쓰기 | 통과 | 최초 [search.json](search.json), [mixed.json](mixed.json), [join.json](join.json), [integrity-write.json](integrity-write.json)의 판정 유지. | Drizzle Kit 첫 적용과 공개 `searchWithQuery` 경로는 Drizzle 통합 재설계 대상으로 이번 후속 범위에서 제외했다. |

후속 재현 명령은 프로젝트 루트에서 `rtk proxy node --import tsx bench/verify-core/wide.ts`, `boundary-db.ts`, `candidate-tamper.ts`, `public-or.ts`다. 각 스크립트는 `guard()`를 먼저 호출한다. 관찰된 제품 결함은 없고, 앞서 재현한 DB 후보 누락과 이번에 확인한 일반 컬럼 OR 불가는 설계상 한계다.
