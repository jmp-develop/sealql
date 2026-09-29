# R9 구현 검증

미검증: 실제 Cloudflare/Hyperdrive 배포, 운영 로캘/부하, 전체 사전·동시출현·WAL 공격 재실행, 악의적 DB의 SQL 무결성 증명은 범위 밖이다. 평문 대비 약 2배 목표를 달성했다고 주장하지 않는다. 로컬 합성 fixture와 메모리 공개 리뷰 결과는 운영 보장·보안 인증이 아니다.

## 전/후와 판정

| 항목 | 이전 | 구현/실제 확인 | 판정 |
|---|---|---|---|
| count | 후보 전송·조건 인증 복호화 | DB 스칼라, 요청1/반환1/복호화0 | 통과 |
| 목록 | 앱 조건 판정 | 최종 DB 정답만, 목록300의 선택6필드=1,800회 인증 복호화 | 통과 |
| CRUD | 토큰 원자성 | 도장 포함 부분수정·동시8쓰기·롤백·reindex·삭제 | 회귀 통과 |
| 연산 | 기존 의미 | eq/contains/words/starts/ends/LIKE·singleton/AND/OR/NULL·비텍스트·빈값·반복·45자 | 평문 oracle 통과 |
| 설치 | kit companion | MAIN 추가 SQL2회 후 generate/migrate/push2회 무변경 | 통과 |
| X5 | inner scope 유지 | 제거의 일관된 이득 없음, exact 목록 SQL 1.103→1.484ms | 미채택 |
| exact bits | 최소8, 기본16 | 명시2 허용, 기본16·population helper 불변 | 통과 |

## 최종 성능

명령: `rtk proxy node --import tsx bench/r9/measure.ts sorted` 및 `random`. 최초 호출을 별도 보관하고 예열2회 후 순서를 교차한7회 중앙값이다. 각 호출에서 count 또는 반환 ID 순서와 정규화6필드 전체를 평문과 대조했다. 제품 함수를 extraMigrationSql로 설치해 측정했으며 연구 함수 대체 설치를 하지 않았다. 보호 연구/원본 테이블은 읽기만 했다.

제품은 fixture 유래의 같은10만 ID/값을 자체 스키마에 재암호화했다. 연구 목록은 기존 동일 ID의 암호문을 읽고 정규화한다. 물리 순서는 제품 부모·companion을 ID순 또는 기존 ID의 md5순으로만 재배치했다. 연구·평문 물리 순서는 변경하지 않았다. 평문 C 로캘 한글 LIKE는 전체 스캔이므로 배율을 성능 주장에 쓰지 않는다. OS 캐시는 비우지 않았다. 각 칸은 **SQL 요청~응답 / 전체 ms**이며 서로 다른 지표의 중앙값은 합산되지 않는다.

| 조건 | 모드 | 평문 정렬 | 연구 정렬 | 제품 정렬 | 평문 무작위 측정 | 연구 무작위 측정 | 제품 무작위 |
|---|---|---:|---:|---:|---:|---:|---:|
| company = "서울서비스 담당" | count | 7.7 / 7.8 | 71.2 / 71.7 | 58.3 / 59.3 | 8.1 / 8.2 | 82.8 / 83.2 | 61.7 / 62.7 |
| company = "서울서비스 담당" | list | 1.2 / 1.3 | 4.0 / 74.1 | 2.6 / 65.5 | 1.2 / 1.3 | 3.8 / 77.2 | 3.4 / 66.0 |
| memo contains "서비스" | count | 16.9 / 17.0 | 352.6 / 353.1 | 276.7 / 277.8 | 17.3 / 17.3 | 353.7 / 354.2 | 275.2 / 276.2 |
| memo contains "서비스" | list | 1.3 / 1.4 | 93.6 / 161.3 | 123.7 / 183.4 | 1.3 / 1.3 | 95.0 / 161.0 | 133.8 / 195.3 |
| address startsWith "서울" | count | 8.1 / 8.2 | 97.0 / 97.4 | 143.3 / 144.3 | 8.4 / 8.5 | 100.1 / 100.5 | 141.3 / 142.3 |
| address startsWith "서울" | list | 1.4 / 1.5 | 52.8 / 121.5 | 61.9 / 122.5 | 1.5 / 1.5 | 54.0 / 118.5 | 67.4 / 132.1 |
| email endsWith "biz.test" | count | 15.6 / 15.7 | 555.7 / 556.6 | 536.8 / 538.2 | 16.4 / 16.5 | 563.5 / 564.3 | 551.9 / 553.5 |
| email endsWith "biz.test" | list | 1.4 / 1.4 | 85.3 / 153.8 | 107.7 / 174.0 | 1.4 / 1.5 | 87.4 / 160.6 | 122.2 / 185.2 |
| (company = "서울서비스 담당" AND memo contains "서비스") | count | 10.0 / 10.0 | 254.0 / 254.6 | 259.5 / 260.7 | 10.4 / 10.5 | 257.8 / 258.6 | 258.1 / 259.5 |
| (company = "서울서비스 담당" AND memo contains "서비스") | list | 1.6 / 1.6 | 86.2 / 152.5 | 110.3 / 173.8 | 1.5 / 1.6 | 86.4 / 156.9 | 104.6 / 168.5 |
| (name contains "민서" AND phone contains "-5" AND address contains "서울" AND memo contains "서비스" AND email contains "test" AND company = "서울서비스 담당") | count | 7.3 / 7.3 | 27.3 / 28.6 | 30.0 / 32.6 | 7.2 / 7.2 | 26.7 / 28.1 | 29.3 / 31.8 |
| (name contains "민서" AND phone contains "-5" AND address contains "서울" AND memo contains "서비스" AND email contains "test" AND company = "서울서비스 담당") | list | 8.3 / 8.4 | 22.4 / 90.8 | 21.6 / 86.1 | 8.6 / 8.7 | 22.5 / 94.6 | 22.5 / 87.7 |
| (company = "서울서비스 담당" OR memo contains "푸른달") | count | 18.1 / 18.2 | 134.4 / 135.0 | 143.7 / 144.8 | 17.9 / 18.0 | 131.2 / 131.8 | 147.0 / 148.3 |
| (company = "서울서비스 담당" OR memo contains "푸른달") | list | 1.3 / 1.3 | 6.2 / 74.0 | 4.9 / 70.3 | 1.2 / 1.3 | 6.0 / 72.6 | 5.1 / 67.0 |
| memo contains "상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용" | count | 21.7 / 21.8 | 32.4 / 34.1 | 17.4 / 19.6 | 21.6 / 21.7 | 31.8 / 33.6 | 17.6 / 19.8 |
| memo contains "상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용" | list | 21.8 / 21.8 | 46.6 / 48.3 | 23.4 / 26.2 | 21.6 / 21.7 | 47.0 / 48.9 | 23.9 / 26.5 |

물리 상관도: sorted customers.id=1.00000, customers_seal_index.row_id=1.00000; random customers.id=0.00952, customers_seal_index.row_id=0.00179.

연구보다 추가되는 비용: 주소 count는 부모 scope 결합과 큰 heap, AND6 count는 부모 결합 및 추가 proof payload, 메모 목록은 큰 heap의 후보 접근·정렬 및 부모 투영이다(실행 계획·저장 크기에 근거한 원인 해석). 초기 단발 비교에서 주소 count1.54–1.59배·AND6 count1.47배·메모 목록1.22–1.27배가 남아 코디네이터가 추가 튜닝 중단을 승인했다. 최종 교차 측정에서는 주소 count1.41–1.48배, AND6 count1.13–1.14배, 무작위 메모 목록1.21배다. 목표 미달을 통과로 바꾸지 않았다. 연구 AND6 현재 SQL 재측정도 제품과 근접했다.

원본: [정렬](performance-sorted.json), [무작위](performance-random.json). 모든 경로의 SQL요청수는1이다. 제품 count는 후보를 앱으로 보내지 않으며 목록은0 또는300행이다. 내부 coarse 후보 수는 다음 별도 측정이다.

| 조건 | DB 토큰 후보 | 최종 일치 | 앱 count 행 | 앱 목록 행 / 인증 필드 |
|---|---:|---:|---:|---:|
| exact_common | 38911 | 28331 | 1 | 300 / 1800 |
| sub_common_memo | 40097 | 40097 | 1 | 300 / 1800 |
| starts | 16574 | 16574 | 1 | 300 / 1800 |
| ends | 26598 | 26598 | 1 | 300 / 1800 |
| and2 | 23905 | 21176 | 1 | 300 / 1800 |
| and6 | 634 | 624 | 1 | 300 / 1800 |
| or2 | 38970 | 28400 | 1 | 300 / 1800 |
| sub45 | 2440 | 0 | 1 | 0 / 0 |

명령: `rtk proxy node --import tsx bench/r9/candidates.ts`; [원본](candidates.json). X5는 결과 count/행 동일성 단언 후 EXPLAIN ANALYZE BUFFERS 3회 교차로 비교했다. [계획 종류와 실행시간](x5.json); 상세 계획은 `.local/r9-x5.json`. 초기105→498ms는 저장 JSON의 bytea 복원 오류로 **폐기**했으며 채택 판단에 쓰지 않았다.

## 용량과 쓰기

명령: `rtk proxy node --import tsx bench/r9/proofs.ts`. 10만 행, 십진 MB. 모든6필드의 words를 켠 비교다. 기본 wordBoundary=false이면 words 칸 자체가 없음을 schema 시험에서 확인했다.

| Companion | heap MB | 색인 MB | 전체 MB (TOAST 포함) | 전체 B/행 |
|---|---:|---:|---:|---:|
| test_r9_performance.customers_seal_index | 204.95 | 97.47 | 876.55 | 8765.5 |
| test_r9_performance_main.customers_seal_index | 409.60 | 145.24 | 988.46 | 9884.6 |
| research_u.pb_4_final | 205.27 | 103.00 | 411.58 | 4115.8 |

| 필드 | compact B/행 | words 추가 B/행 | single 추가 B/행 |
|---|---:|---:|---:|
| name | 162.3 | 159.5 | 173.3 |
| phone | 195.0 | 193.0 | 205.0 |
| address | 231.2 | 227.8 | 239.8 |
| memo | 229.2 | 226.5 | 238.5 |
| email | 301.9 | 296.9 | 308.9 |
| company | 162.3 | 158.6 | 171.7 |

열별 pg_column_size 합은 tuple/색인 오버헤드를 제외하고 압축 영향을 받을 수 있다. [전체 열별 수치](proofs-size.json). exact 색인은 필드당 약5.9→13.1MB, row_id unique는 약3.18MB였다. 꼬리 키를 UUID 고정 크기에 한정하고 exact 토큰 배열1개 CHECK로 B-tree 항목 크기를 제한했다. text 식별자는 기존 좁은 색인을 유지한다.

명령: `rtk proxy node --import tsx bench/r9/writes.ts`. 같은 현재 API로 같은16행의6필드를 같은 값으로 수정, 행당 트랜잭션, 예열2·교차7. 기존물리설정과 MAIN/추가색인을 합친 비용 비교이며 개별 색인만의 비용은 분리 측정하지 않았다. [원본](writes.json).

| 설정 | 전체 ms | SQL ms | 요청수 |
|---|---:|---:|---:|
| test_r9_performance | 293.0 | 44.1 | 64 |
| test_r9_performance_main | 303.3 | 51.5 | 64 |

전체+3.5%, SQL+17.0%. 최초 제품 API의6필드 전체10만 행 적재는1,375,094ms(약22.9분)였다. 이 적재에는 세 위치 스트림 생성 비용이 포함되며 읽기 성능 수치로 대신하지 않는다.

## 기계적 누출 시험

fixture250행과 공개리뷰250행을 메모리에서 동일 compact2/words2/single1 알고리즘으로 검사했다. 공개리뷰는 DB에 적재하지 않았다. 저장된 위치를 정렬하면 알려진 길이의 전체 위치 집합이고, 도장 동일성은 행/스트림 salt로 분리되는지 검사했다. 관찰된 첫 조각 키로 등장순번 도장을 계산하는 T4 공격을 실행해 평문 위치와 대조했다.

| 자료 | 도장 수 | 행 내부/외부 중복 | 위치 순열 오류 | 관찰키 위치 복원 / 오류 | 길이차로 보이는 공백 |
|---|---:|---:|---:|---:|---:|
| fixture | 11342 | 0/0 | 0 | 797/0 | 868 |
| public-review-memory-only | 22743 | 0/0 | 0 | 906/0 | 1640 |

중복0은 안전 증명이 아니다. 관찰 키의 위치 복원, 길이 및 공백 수 누출을 확인했으며 기존 HMAC 빈도·동시출현 누출은 남는다. 사용한 공격 목록은 하한이다. 전체 사전/알려진행/복합복원/WAL 공격은 이번에 다시 실행하지 않았다.

## 드라이버와 게이트

`rtk proxy node --import tsx --test test/standard-workerd-db.test.ts`: `tests 1 / pass 1 / fail 0`; Node pg와 local workerd pg 모두 `{ok:true,insert:1,count:1,update:1,reindex:1,search:1,substring:1,afterDelete:0}`. `rtk proxy node --import tsx .local/r9-postgres-flow.ts`의 postgres-js도 같은 출력이다. 패키지 최신 build를 사용했다. [드라이버 원본](drivers.json).

`rtk proxy node --import tsx --test --test-name-pattern=transactionless test/standard-drizzle.test.ts`: `tests 1 / pass 1 / fail 0`. transactionless의 insert/update/upsert/reindex는 UNSUPPORTED_DRIVER, 일반 연결 오류/SQLSTATE는 DATABASE_ERROR를 유지했다.

| 명령 | 실제 출력/판정 |
|---|---|
| `rtk npm run build` | tsc exit0 |
| `rtk npm run check` | tsc --noEmit exit0 |
| `rtk npm test` | tests 36 / pass 36 / fail 0 / duration_ms 144783.1572; 이후 추가 scalar 계약 시험 별도1/1 |
| `rtk npm run docs:check` | Documentation entry, links, decisions, plans, exports, and shared example references PASS |
| `rtk npm run test:install` | Installed standard consumer compiles with drizzle-orm 0.45.3 / 0.45.2; 독립 upstream 선언70개 제외, kit 생성 성공 |

개별 게이트: postgres9/9(긴 값·오탐·count 포함), schema/kit/R9/stamps6/6, 실제 driver1/1. 전체 suite 실행을 시작한 뒤 추가한 scalar count 계약 시험은 Number.MAX_SAFE_INTEGER·overflow·잘못된 결과 형태·제거 예산·취소를 검증해 별도1/1 통과했다. 장문 회귀는 70,000자급 반복 값과2,050자 질의도 포함한다. [시험 이름·명령·실제 출력](gates.txt)을 보관한다.

## 재현과 변경 경계

DB는127.0.0.1:56439이며 모든 실행은 assertDisposable과 port를 먼저 확인했다. 보호 schema·기존 연구 결과 파일은 수정하지 않았다. 시험은 test_r9 계열 새 schema만 썼다. 측정 스크립트는 [bench/r9](../../r9/)에 있으며10만 행 파생 준비/물리순서 스크립트는 `.local/r9-performance.ts`, `.local/r9-main-storage.ts`, `.local/r9-tail-index.ts`, `.local/r9-layout.ts`다. 기존 schema가 있으면 다시 적재하지 않는다. 코드·설치는 [015](../../../docs/decisions/015-database-search-proofs.md), bits2는 [016](../../../docs/decisions/016-coarse-exact-bits.md)을 따른다.
