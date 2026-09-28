# MongoDB 8.2.12 Queryable Encryption 재측정 (mongo2)

## N = 51,546 (예열 2 + 교차 7)

**100,000건에 도달하지 못했다.** 이어 적재(m2-continue.mjs)의 누적 속도가 17.7~29.5 docs/s라, 사용자 요청으로 조정자가 2026-09-28T21:04:36Z에 적재를 멈췄다(마지막 완료 배치 기록 직후 프로세스 종료). 그 시점 QE 문서 N = 51,546.

측정 2026-09-28T21:05:00.420Z. mongod 8.2.12 Community, 1노드 레플리카셋 rs0(127.0.0.1:27117), Node 드라이버 mongodb 7.6.0 + mongodb-client-encryption 7.2.1, 명시적 암호화(`ClientEncryption.encrypt` + `bypassQueryAnalysis`), contention 8, 기본 write concern. 데이터는 PostgreSQL `research_u.customers_plain`의 정규화 값(`*_norm`, id 순)을 읽기 전용으로 내보낸 것(`bench/research-mongo2/export.ts`). 문서 `_id` = id 순번(1부터).

비교 대상: QE `mongo2.qe` 51,546건 대 평문 `mongo2.plain_n`(평문 100,000건에서 QE와 **같은 `_id` 집합**만 복사, 같은 단일 필드 인덱스 company, phone, name, email; `_id` 조건 없음). QE `_id`는 1~50991이 연속이고, 나머지 555건은 중단 때 진행 중이던 insertMany 배치(순서 삽입)가 일부만 들어간 것이다(최대 `_id` 51582, 연속 아님). plain_n은 같은 집합이라 count·목록 비교는 같은 행에서 한다.

반복: 예열 2회 + 교차 7회 중앙값(ms). 평문과 QE를 반복마다 순서를 바꿔 번갈아 잰다. QE 시간은 질의 페이로드 생성(클라이언트 암호화) 포함, 목록은 `find().sort({_id:1}).limit(300)` + 드라이버 자동 복호화 포함. 측정 잠금(`.local/research/measure.lock`, "m2-fable mongo2-N"): 획득 2026-09-28T21:05:26.761Z, 해제 2026-09-28T21:08:45.430Z, 대기 0.0 s. 잠금은 시간 측정 구간에만 잡았다(정합성 확인·explain·collStats는 잠금 전).

### 표 1. 적재

| 항목 | 값 |
|---|---|
| 최종 QE N | 51546 (countDocuments; 연속 _id 1~50991, 최대 _id 51582) |
| 1구간 (m2-load.mjs) | 23500건, 623.8 s, 37.7 docs/s (시작 2026-09-28T20:30:26.916Z) |
| 2구간 (m2-continue.mjs) | 시작 2026-09-28T20:48:41.176Z (max_id 23500); 마지막 완료 배치 기록 2026-09-28T21:04:35.831Z: 27000건, 954.6 s, 28.3 docs/s; 2026-09-28T21:04:36Z 중단, 진행 중 배치에서 1046건 추가로 들어감 |
| QE 적재 합계 (완료 배치 기준) | 50500건 / 1578.4 s (26.3 분) = 32.0 docs/s (두 구간 벽시계 합, 구간 사이 N = 23,500 측정 시간 제외; 4개 연결 병렬, insertMany 500) |
| 평문 100,000건 적재 | 1.72 s = 58289 docs/s (연결 1개, insertMany 500 순차) + 단일 필드 인덱스 4개 1.38 s |
| 문서당 적재 속도 QE / 평문 | 평문 58289 docs/s 대 QE 32.0 docs/s = 1821.9× 느림 |
| 60 코드포인트 절단 (100,000건 중) | memo 234건, address 0건 (평문·QE 모두 절단) |

### 표 2. 저장 공간 (collStats storageStats)

| 컬렉션 | count | size B | storageSize B | totalIndexSize B | size B/문서 | (storageSize+index) B/문서 |
|---|---|---|---|---|---|---|
| mongo2.plain | 100000 | 25728270 | 12505088 | 10280960 | 257.3 | 227.9 |
| mongo2.qe | 51546 | 3734397350 | 3800633344 | 3043364864 | 72447.9 | 132774.6 |
| mongo2.enxcol_.qe.esc | 26738046 | 1256688162 | 2531794944 | 0 | 47.0 | 94.7 |
| mongo2.enxcol_.qe.ecoc | 26738046 | 2852713338 | 924889088 | 0 | 106.7 | 34.6 |
| mongo2.plain_n | 51546 | 13237270 | 4935680 | 4911104 | 256.8 | 191.0 |

| 비교 (문서 1건당, 평문 = plain_n) | 평문 | QE | QE / 평문 |
|---|---|---|---|
| 논리 크기: qe 본체 size | 256.8 B | 72447.9 B | 282.1× |
| 논리 크기: qe + esc + ecoc size | 256.8 B | 152170.9 B | **592.6×** |
| 디스크: qe 본체 storageSize + index | 191.0 B | 132774.6 B | 695.0× |
| 디스크: qe + esc + ecoc storageSize + index | 191.0 B | 199834.8 B | **1046.1×** |
| 합계 (디스크) | 9.4 MiB | 9823.5 MiB | - |

ESC 문서 수 / QE 문서 = 518.7, ECOC 문서 수 / QE 문서 = 518.7. 컴팩션(compactStructuredEncryptionData)은 하지 않았다. plain_n은 방금 새로 만든 컬렉션이라 storageSize가 오래 쓴 컬렉션보다 작을 수 있다.

### 표 3. 질의별

| 조건 전문 | 실제 일치(평문 count) | MongoDB 평문 count ms | MongoDB QE count ms (배) | MongoDB 평문 목록300 ms | MongoDB QE 목록300 ms (배) | 지원 여부/비고 | 태그 수(explain) |
|---|---|---|---|---|---|---|---|
| company = "서울서비스담당" | 14538 | 4.93 | 141.02 (28.6×) | 5.06 | 301.08 (59.5×) | 지원, count·목록 평문과 일치 (목록 300행) | 14538 |
| company = "서울서비스중앙지사" | 920 | 1.33 | 13.93 (10.5×) | 5.50 | 183.45 (33.4×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 |
| phone = "42-5748-1542" | 1 | 0.98 | 3.53 (3.6×) | 0.81 | 3.67 (4.6×) | 지원, count·목록 평문과 일치 (목록 1행) | 미수집 |
| phone = "99-0000-0000" | 0 | 0.97 | 2.40 (2.5×) | 0.67 | 2.27 (3.4×) | 지원, count·목록 평문과 일치 (목록 0행) | 미수집 |
| memo ∋ "서비스" | 20802 | 49.46 | 823.74 (16.7×) | 4.64 | 252.00 (54.4×) | 지원, count·목록 평문과 일치 (목록 300행) | 20802 |
| memo ∋ "푸른달" | 52 | 48.78 | 5.28 (0.1×) | 117.19 | 30.14 (0.3×) | 지원, count·목록 평문과 일치 (목록 52행) | 미수집 |
| memo ∋ "없는표식" | 0 | 53.84 | 3.24 (0.1×) | 112.78 | 2.76 (0.0×) | 지원, count·목록 평문과 일치 (목록 0행) | 미수집 |
| memo ∋ "상담서비스" | 0 | 54.74 | 3.11 (0.1×) | 113.42 | 2.76 (0.0×) | 지원, count·목록 평문과 일치 (목록 0행) | 미수집 |
| memo ∋ "서비스상담" | 15474 | 52.36 | 421.65 (8.1×) | 5.54 | 356.51 (64.4×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 |
| memo ∋ "비스상" | 15474 | 48.06 | 524.20 (10.9×) | 6.32 | 333.26 (52.8×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 |
| address ∋ "세종대로" | 8640 | 59.76 | 1141.34 (19.1×) | 7.97 | 397.48 (49.9×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 |
| address ∋ "세종대로25" | 107 | 47.45 | 10.55 (0.2×) | 110.37 | 69.31 (0.6×) | 지원, count·목록 평문과 일치 (목록 107행) | 미수집 |
| memo ∋ "상세안내와확인내용상세안내와" | 1258 | - | - | - | - | MongoDB 미지원: StrQuery: string value was longer than the maximum query length for this field after folding -- folded codepoint len: 14, max query len: 10 | - |
| memo ∋ "상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용" | 0 | - | - | - | - | MongoDB 미지원: StrQuery: string value was longer than the maximum query length for this field after folding -- folded codepoint len: 45, max query len: 10 | - |
| (company = "서울서비스담당" AND memo ∋ "서비스") | 10905 | 29.71 | 1385.61 (46.6×) | 6.20 | 392.30 (63.3×) | 지원, count·목록 평문과 일치 (목록 300행) | 14538 + 20802 (조건별) |
| (company = "서울서비스담당" OR memo ∋ "푸른달") | 14572 | 45.40 | 163.82 (3.6×) | 5.75 | 360.41 (62.7×) | 지원, count·목록 평문과 일치 (목록 300행) | 14538 + 52 (조건별) |
| ((company = "서울서비스담당" AND memo ∋ "서비스") OR memo ∋ "푸른달") | 10957 | 55.01 | 1387.07 (25.2×) | 6.43 | 455.72 (70.9×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 |
| (company = "서울서비스담당" AND address ∋ "부산") | 2443 | 29.21 | 2990.51 (102.4×) | 16.22 | 1164.10 (71.8×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 |
| (company = "서울서비스담당" OR memo ∋ "푸른달" OR phone = "42-5748-1542" OR address ∋ "세종대로") | 20784 | 65.75 | 4394.14 (66.8×) | 5.18 | 2582.75 (498.4×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 |
| (((company = "서울서비스담당" AND memo ∋ "서비스") OR (address ∋ "서울" AND memo ∋ "상담")) AND (phone = "42-5748-1542" OR memo ∋ "푸른달")) | 0 | 62.71 | 123.05 (2.0×) | 124.60 | 105.89 (0.8×) | 지원, count·목록 평문과 일치 (목록 0행) | 미수집 |
| name / phone / email / company의 포함(contains) | - | - | - | - | - | MongoDB 미지원 (equality-only field) | - |
| memo / address의 startsWith / endsWith | - | - | - | - | - | MongoDB 미지원 with this config: 서버가 한 필드에 substringPreview와 prefixPreview/suffixPreview 결합을 거부 ("rejected: Multiple query types may only include the suffixPreview and prefixPreview query types"; 3종 결합은 "rejected: The number of query types for an encrypted field cannot exceed two"; prefix+suffix 2종만은 accepted). N과 무관한 설정 검사라 N = 23,500 때 결과를 그대로 쓴다 | - |

질의 값은 저장 정규화와 같게 공백을 뺀 값을 쓴다(company "서울서비스 담당" → "서울서비스담당", "서울서비스 중앙지사" → "서울서비스중앙지사"). 평문 contains는 인덱스 없는 `$regex`(전체 스캔), 평문 exact는 단일 필드 인덱스. 배율은 QE ms / 평문 ms. 목록 일치는 앞 300개 `_id`(오름차순) 비교. memo는 60 코드포인트로 절단된 값 기준이라 PostgreSQL 전문 memo와 일치 수가 다를 수 있다.

### 표 4. explain (executionStats, QE count 명령)

| 질의 | 재작성된 `$in` 태그 수 | totalKeysExamined | totalDocsExamined | executionTimeMillis |
|---|---|---|---|---|
| company = "서울서비스담당" | 14538 | 29070 | 14538 | 175 |
| memo ∋ "서비스" | 20802 | 41583 | 20802 | 597 |
| (company = "서울서비스담당" AND memo ∋ "서비스") | 14538 + 20802 (조건별) | 29070 | 14538 | 943 |
| (company = "서울서비스담당" OR memo ∋ "푸른달") | 14538 + 52 (조건별) | 29174 | 14572 | 182 |

서버는 암호화 조건을 `__safeContent__: {$elemMatch: {$in: [태그...]}}`로 바꾼다. 태그 수는 explain 문서(queryPlanner)의 `__safeContent__` `$in` 길이다(parsedQuery와 plan에 같은 값이 반복되며, AND/OR는 조건별 값을 company + memo 순으로 적었다). explain은 잠금 밖에서 1회 실행한 값이다.

스크립트: `bench/research-mongo2/` (export.ts, m2-lib.mjs, m2-load.mjs, m2-continue.mjs, m2-stopn.mjs, m2-measure.mjs, m2-combo.mjs, m2-report.mjs, m2-report-n.mjs; mongo 스크립트는 실험 디렉터리의 lib.mjs·node_modules로 실행). 이번 측정 명령: `node m2-stopn.mjs` 후 `N=51546 PLAIN_COLL=plain_n OUT=out/m2-measure-n.json LOCK_TAG="m2-fable mongo2-N" node m2-measure.mjs 2 7`. 원자료: `mongo2-measure-51546.json`.

## 부록: N = 23,500 (예열 1 + 3)

측정 2026-09-28T20:40:55.070Z. mongod 8.2.12 Community, 1노드 레플리카셋 rs0(127.0.0.1:27117), Node 드라이버 mongodb 7.6.0 + mongodb-client-encryption 7.2.1, 명시적 암호화(`ClientEncryption.encrypt` + `bypassQueryAnalysis`), contention 8, 기본 write concern. 데이터는 PostgreSQL `research_u.customers_plain`의 정규화 값(`*_norm`, id 순)을 읽기 전용으로 내보낸 것(`bench/research-mongo2/export.ts`). 문서 `_id` = id 순번(1부터). 모든 측정은 QE에 적재된 앞 N건과 평문의 `_id ≤ N` 같은 행에서 한다.

반복: 예열 1회 + 교차 3회 중앙값(ms). **시간 부족으로 예열 1 + 3회로 줄였다.** QE 시간은 질의 페이로드 생성(클라이언트 암호화) 포함, 목록은 `find().sort({_id:1}).limit(300)` + 드라이버 자동 복호화 포함. 측정 잠금: 획득 2026-09-28T20:47:11.156Z, 해제 2026-09-28T20:47:56.616Z, 대기 360.2 s.

### 표 1. 적재

| 항목 | 값 |
|---|---|
| QE 적재 N (시간 제한 내) | 23500 (마지막 _id 23500, countDocuments 23500) |
| QE docs/s | 37.7 (4개 연결 병렬, insertMany 500) |
| QE 벽시계 | 623.8 s |
| 평문 100,000건 적재 | 1.72 s = 58289 docs/s (연결 1개, insertMany 500 순차) + 단일 필드 인덱스 4개 1.38 s |
| 60 코드포인트 절단 (100,000건 중) | memo 234건, address 0건 (평문·QE 모두 절단) |
| 시간 제한 | 지시는 22분, 마감 때문에 약 9.5분으로 줄임 (시작 2026-09-28T20:30:26.916Z, 새 배치 발행 정지 2026-09-28T20:40:00Z; 앞선 두 적재 시도는 셸 kill이 Volta node.exe를 못 죽여 서로 겹쳐서 ~20:30에 모두 중단하고 컬렉션을 지운 뒤 새로 적재, 진행 중 배치는 완료까지 기다림 → 앞 N건이 연속) |
| PostgreSQL 측정 겹침 | lockBefore 2026-09-28T20:24:46Z: m1-astra-pb1d 46784 2026-09-28T20:23:53.548Z / lockBefore2 2026-09-28T20:25:33Z: m1-astra-pb1d 51008 2026-09-28T20:25:31.311Z / note: first two load attempts (20:24:47 and 20:25:33 starts) overlapped and were killed at ~20:30; clean restart below / lockBefore3 2026-09-28T20:30:26Z: m1-astra-pb1d 28168 2026-09-28T20:29:18.952Z / lockAfterLoad 2026-09-28T20:40:54Z: m1-astra-pb1d 65948 2026-09-28T20:33:24.917Z |

### 표 2. 저장 공간 (collStats storageStats)

| 컬렉션 | count | size B | storageSize B | totalIndexSize B | size B/문서 | 평문 대비(논리) |
|---|---|---|---|---|---|---|
| mongo2.plain | 100000 | 25728270 | 10493952 | 10293248 | 257.3 | 1× |
| mongo2.qe | 23500 | 1700366728 | 1730433024 | 1604677632 | 72356.0 | 281.2× (자기 count 기준) |
| mongo2.enxcol_.qe.esc | 12174342 | 572194074 | 1181446144 | 0 | 47.0 | 0.2× (자기 count 기준) |
| mongo2.enxcol_.qe.ecoc | 12174342 | 1298898014 | 420245504 | 0 | 106.7 | 0.4× (자기 count 기준) |
| **QE 합계(qe+esc+ecoc) / QE 문서** | 23500 | - | - | - | 151977 | **590.7×** (디스크 storageSize+index: 210077 B/문서 대 평문 208 = 1010.6×) |

평문 컬렉션은 100,000건 전체(인덱스 company, phone, name, email)라 문서당 값으로 비교한다. ESC 문서 수 / QE 문서 = 518.1.

### 표 3. 질의별

| 조건 전문 | 실제 일치(평문 count, 앞 N건) | MongoDB 평문 count ms | MongoDB QE count ms (배) | MongoDB 평문 목록300 ms | MongoDB QE 목록300 ms (배) | 지원 여부/비고 | 태그 수(explain) | 평문 N건 복사본 count ms (QE 배) | 평문 N건 복사본 목록300 ms (QE 배) |
|---|---|---|---|---|---|---|---|---|---|
| company = "서울서비스담당" | 6684 | 37.31 | 66.11 (1.8×) | 5.14 | 281.40 (54.7×) | 지원, count·목록 평문과 일치 (목록 300행) | 6684 (parsedQuery·plan 두 곳 동일) (count explain) | 3.16 (20.9×) | 5.03 (56.0×) |
| company = "서울서비스중앙지사" | 430 | 4.83 | 8.45 (1.7×) | 12.71 | 232.21 (18.3×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 | 1.32 (6.4×) | 4.44 (52.3×) |
| phone = "42-5748-1542" | 1 | 1.08 | 2.87 (2.7×) | 0.81 | 3.30 (4.1×) | 지원, count·목록 평문과 일치 (목록 1행) | 미수집 | 0.87 (3.3×) | 0.66 (5.0×) |
| phone = "99-0000-0000" | 0 | 1.08 | 2.39 (2.2×) | 0.76 | 2.39 (3.1×) | 지원, count·목록 평문과 일치 (목록 0행) | 미수집 | 1.11 (2.2×) | 0.59 (4.0×) |
| memo ∋ "서비스" | 9452 | 39.50 | 344.14 (8.7×) | 4.73 | 238.78 (50.4×) | 지원, count·목록 평문과 일치 (목록 300행) | 9452 (parsedQuery·plan 두 곳 동일) (count explain) | 22.29 (15.4×) | 4.18 (57.1×) |
| memo ∋ "푸른달" | 24 | 37.63 | 3.55 (0.1×) | 44.33 | 24.27 (0.5×) | 지원, count·목록 평문과 일치 (목록 24행) | 미수집 | 20.57 (0.2×) | 45.44 (0.5×) |
| memo ∋ "없는표식" | 0 | 38.44 | 2.13 (0.1×) | 45.16 | 2.45 (0.1×) | 지원, count·목록 평문과 일치 (목록 0행) | 미수집 | 22.43 (0.1×) | 47.86 (0.1×) |
| memo ∋ "상담서비스" | 0 | 39.12 | 1.98 (0.1×) | 45.51 | 2.52 (0.1×) | 지원, count·목록 평문과 일치 (목록 0행) | 미수집 | 21.84 (0.1×) | 46.29 (0.1×) |
| memo ∋ "서비스상담" | 7073 | 42.38 | 182.71 (4.3×) | 5.10 | 269.28 (52.8×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 | 22.18 (8.2×) | 4.67 (57.6×) |
| memo ∋ "비스상" | 7073 | 39.39 | 218.96 (5.6×) | 6.19 | 281.63 (45.5×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 | 20.75 (10.6×) | 4.74 (59.4×) |
| address ∋ "세종대로" | 3833 | 42.12 | 416.27 (9.9×) | 10.42 | 369.47 (35.5×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 | 23.69 (17.6×) | 7.32 (50.4×) |
| address ∋ "세종대로25" | 43 | 39.09 | 6.21 (0.2×) | 45.90 | 35.47 (0.8×) | 지원, count·목록 평문과 일치 (목록 43행) | 미수집 | 22.67 (0.3×) | 50.61 (0.7×) |
| memo ∋ "상세안내와확인내용상세안내와" | 574 | - | - | - | - | MongoDB 미지원: StrQuery: string value was longer than the maximum query length for this field after folding -- folded codepoint len: 14, max query len: 10 | - | 21.34 | 26.80 |
| memo ∋ "상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용" | 0 | - | - | - | - | MongoDB 미지원: StrQuery: string value was longer than the maximum query length for this field after folding -- folded codepoint len: 45, max query len: 10 | - | 20.95 | 45.72 |
| (company = "서울서비스담당" AND memo ∋ "서비스") | 4997 | 44.65 | 603.71 (13.5×) | 5.71 | 315.34 (55.2×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 | 13.70 (44.1×) | 5.45 (57.9×) |
| (company = "서울서비스담당" OR memo ∋ "푸른달") | 6697 | 38.47 | 79.63 (2.1×) | 4.85 | 313.25 (64.5×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 | 20.91 (3.8×) | 4.69 (66.7×) |
| ((company = "서울서비스담당" AND memo ∋ "서비스") OR memo ∋ "푸른달") | 5021 | 43.33 | 623.84 (14.4×) | 10.91 | 343.89 (31.5×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 | 24.75 (25.2×) | 6.10 (56.4×) |
| (company = "서울서비스담당" AND address ∋ "부산") | 1098 | 46.08 | 1282.61 (27.8×) | 16.53 | 882.18 (53.4×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 | 14.65 (87.6×) | 15.78 (55.9×) |
| (company = "서울서비스담당" OR memo ∋ "푸른달" OR phone = "42-5748-1542" OR address ∋ "세종대로") | 9446 | 51.07 | 1608.44 (31.5×) | 5.93 | 975.19 (164.4×) | 지원, count·목록 평문과 일치 (목록 300행) | 미수집 | 30.31 (53.1×) | 4.98 (196.0×) |
| (((company = "서울서비스담당" AND memo ∋ "서비스") OR (address ∋ "서울" AND memo ∋ "상담")) AND (phone = "42-5748-1542" OR memo ∋ "푸른달")) | 0 | 49.21 | 58.64 (1.2×) | 57.03 | 50.97 (0.9×) | 지원, count·목록 평문과 일치 (목록 0행) | 미수집 | 31.31 (1.9×) | 56.95 (0.9×) |
| name / phone / email / company의 포함(contains) | - | - | - | - | - | MongoDB 미지원 (equality-only field) | - | - | - |
| memo / address의 startsWith / endsWith | - | - | - | - | - | MongoDB 미지원 with this config: 서버가 한 필드에 substringPreview와 prefixPreview/suffixPreview 결합을 거부 ("rejected: Multiple query types may only include the suffixPreview and prefixPreview query types"; 3종 결합은 "rejected: The number of query types for an encrypted field cannot exceed two"; prefix+suffix 2종만은 accepted) | - | - | - |

질의 값은 저장 정규화와 같게 공백을 뺀 값을 쓴다(company "서울서비스 담당" → "서울서비스담당", "서울서비스 중앙지사" → "서울서비스중앙지사"). 평문 contains는 인덱스 없는 `$regex`(전체 스캔), 평문 exact는 단일 필드 인덱스. **"MongoDB 평문" 열은 100,000건 평문 컬렉션에 `_id ≤ N` 조건을 더한 값**이라 인덱스가 N 밖의 행까지 읽는다(예: company 인덱스 키 28,331개). 그래서 앞 N건만 복사한 `mongo2.plain_n`(같은 인덱스)에서 평문만 다시 잰 값을 마지막 두 열에 둔다(QE와 교차하지 않고 연속 측정, 같은 반복 횟수). 복사본 측정: 2026-09-28T20:48:15.092Z ~ 2026-09-28T20:48:18.137Z, count 23500. memo는 60 코드포인트로 절단된 값 기준이라 PostgreSQL 전문 memo와 일치 수가 다를 수 있다(절단 memo 100,000건 중 234건).

### explain (executionStats, QE count)

| 질의 | 재작성된 `$in` 태그 수 | totalKeysExamined | totalDocsExamined | executionTimeMillis |
|---|---|---|---|---|
| company = "서울서비스담당" | 6684 (parsedQuery·plan 두 곳 동일) | 13366 | 6684 | 107 |
| memo ∋ "서비스" | 9452 (parsedQuery·plan 두 곳 동일) | 18899 | 9452 | 307 |

서버는 암호화 조건을 `__safeContent__: {$elemMatch: {$in: [태그...]}}`로 바꾼다. 태그 수는 그 값(또는 부분 문자열)을 가진 적재 문서 수와 같고, 일치 문서를 모두 읽는다.

스크립트: `bench/research-mongo2/` (export.ts, m2-lib.mjs, m2-load.mjs, m2-measure.mjs, m2-combo.mjs, m2-report.mjs, m2-continue.mjs; mongo 스크립트는 실험 디렉터리의 lib.mjs·node_modules로 실행).

측정 뒤 mongod는 켜 둔 채 `m2-continue.mjs`로 QE 적재를 100,000건까지 이어 간다(실험 디렉터리의 load-continue.log). 이 문서의 값은 모두 위 N건 기준이다.
