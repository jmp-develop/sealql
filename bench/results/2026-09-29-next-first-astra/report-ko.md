# 첫 등장 판정 재설계 — m1-astra 연구 결과

## 판정 및 한계

**최종 판정: 첫 등장 식 결합은 채택 보류. 직접 cast는 성능 개선을 확인했으나 지원 범위를 유지하기 위해 적용 연기로 종결(§7 최종 코디네이터 판정).** 기존 A의 구조적 퇴행은 없앴으나 식 결합 자체의 이득이 전 조건에서 일관되지는 않았다. 제품 코드·커밋 변경 없음. **락 없이, 병행 부하 중** 같은 연결에서 예열2+교차7을 수행했다(코디네이터 후속 승인). 절대값은 참고이며 시간에 따른 병행 부하 차이는 교차로 완전히 제거되지 않는다. 연구 결과의 채택 여부는 아래 표의 전 조건 개선 여부와 정확성을 함께 본다.

이전 측정 스키마가 정리되어 기존 fixture 고객10만 행의 주소·메모·이메일에서 새 임시 표를 파생했다. 고정 연구 codec으로 후보 토큰과 행별 창2 증명을 재생성하고 **현재 src/core/stamp-sql.ts 함수**를 설치했다. 모든 경로가 같은 저장 배열·키·offset·길이·affix를 썼다. 이는 최신 제품의 전체6필드 저장·관리형 쓰기·공개 API 재측정이 아니다. 목록은 직접 WHERE→ORDER BY→LIMIT으로 ID300개만 조회했으며 제품 prefix/fallback과 반환 필드 인증 복호화 시간은 포함하지 않는다. 따라서 공개 API의 200ms 목표 달성 여부를 이 표로 대신하지 않는다.

## 1. 기존 A가 퇴행한 근본 원인

이전 EXPLAIN 근거: bench/results/2026-09-29-final-impl/next-candidates-check.json.

| 조건 | 기존 서버 실행 계획 근거 | 원인 |
|---|---|---|
| 반복 문장 | A SubPlan 2,440회 ×약15µs, 현재77.83→A115.71ms | 모든 창의 첫 등장 위치를 선계산하지만 반복값의 필요한 위치는 첫 등장과 다를 수 있음. 실패하면 원함수를 처음부터 실행해 이미 한 해시·탐색을 반복 |
| 45자 | A SubPlan 2,440회 ×약46µs, SQL519→12,498B, 현재16.19→A130.52ms | 첫 창의 위치+필드 길이로 조기 탈락할 수 있어도 23창 배열부터 만듦. 긴 질의일수록 불필요한 선행 작업 증가 |
| NULL | 현재 Aggregate→Result, 실행0.008ms. A Bitmap→SubPlan 29,843회, 실행265.61ms | STRICT 함수의 NULL 상수 접힘을 외부 CASE/SubPlan이 가림. 결과0임에도 후보를 읽고 창 배열 계산 |

45자 문제를 단순히 n<qlen만의 문제로 좁히면 안 된다. 이번 파생 입력의 해당 후보 길이 분포와 too_short는 원시 JSON candidateInfo에 기록했다. 이번 45자 후보2,440행은 길이48–61자로 too_short=0이었다. n<qlen만의 문제는 아니며 기존 함수는 첫 등장 p>n−qlen 및 창 위치 불일치에서 조기 종료한다.

## 2. 일반 설계 — 별도 첫 등장 패스를 없앰

새 함수는 원래 단일 순번 탐색·전진 커서·조기 종료를 유지한다. 작은 배열에서 해시 계산→array_position→positions 접근을 **하나의 PL 식**으로 수행해 wanted/found 중간 변수 대입·NULL 분기를 줄인다. 큰 배열은 기존 이진 탐색을 유지한다. 다음처럼 바뀌며, 첫 등장만을 위한 사전 계산·fallback 재시작은 없다.

- 기존: wanted := hash; found := array_position(stamps,wanted); if found is null …; p := positions[found].
- 결합: p := positions[array_position(stamps,hash)]; if p is null … .

창 개수2/3/4 등의 전용식이나 검색어별 분기 없음. STRICT/IMMUTABLE/SECURITY INVOKER/search_path/함수 COST1900/큰 배열 임계128은 그대로다. NULL 접힘, n<qlen 및 p>n−qlen 종료도 유지된다. 한 경로는 hex→bit→bigint를 그대로 둬 식 결합만 비교하고, 별도 경로는 이미 동등성을 확인한 bytea→bigint 직접 cast까지 적용한다. 저장물·질의 전송물·키 파생·노출 조각을 바꾸지 않는다.

## 3. SQL 요청~응답 중앙값 (ms)

| 조건 | 조회 | 정답 수 | 현재 | 기존 A | 단일 탐색 결합 | 결합+직접 cast |
|---|---|---:|---:|---:|---:|---:|
| 주소 세종대로 | count | 16574 | 203.06 | 120.32 | 210.77 | 169.75 |
| 주소 세종대로 | list300 | 16574 | 225.14 | 132.52 | 204.23 | 190.97 |
| 메모 서비스 상담 | count | 29843 | 535.89 | 325.39 | 499.58 | 503.84 |
| 메모 서비스 상담 | list300 | 29843 | 525.36 | 324.80 | 523.35 | 471.85 |
| 이메일 biz.test 끝 | count | 26598 | 644.74 | 412.57 | 600.57 | 533.66 |
| 이메일 biz.test 끝 | list300 | 26598 | 595.92 | 414.67 | 584.18 | 547.57 |
| 드문 푸른달 | count | 101 | 1.58 | 1.53 | 1.58 | 1.27 |
| 드문 푸른달 | list300 | 101 | 1.94 | 1.37 | 1.88 | 1.75 |
| 역순 상담서비스 | count | 0 | 0.39 | 0.63 | 0.40 | 0.42 |
| 역순 상담서비스 | list300 | 0 | 0.44 | 0.77 | 0.43 | 0.42 |
| 반복 문장 | count | 2440 | 120.79 | 161.13 | 100.04 | 94.15 |
| 반복 문장 | list300 | 2440 | 112.19 | 183.79 | 104.10 | 95.96 |
| 45자 | count | 0 | 18.97 | 185.71 | 22.14 | 19.43 |
| 45자 | list300 | 0 | 27.98 | 203.09 | 27.11 | 21.63 |
| LIKE %est | count | 100000 | 369.85 | 647.28 | 351.50 | 338.62 |
| LIKE %est | list300 | 100000 | 31.05 | 2.72 | 31.05 | 30.88 |
| NULL 길이 인자 | count | 0 | 0.19 | 244.17 | 0.48 | 0.34 |
| NULL 길이 인자 | list300 | 0 | 0.22 | 239.35 | 0.46 | 0.34 |

첫 실행과 EXPLAIN ANALYZE는 예열 전 별도 실행이다. 표는 예열2 후 교차7의 SQL 왕복 중앙값이며 EXPLAIN 시간을 빼거나 더하지 않았다. 모든 count와 목록300 ID순 결과를 전체 fixture의 독립 평문 판정과 매번 대조했다.

## 4. 새 EXPLAIN 확인

| 조건(count) | 경로 | 서버 실행 ms | SubPlan 반복 합계 | 계획 노드 |
|---|---|---:|---:|---|
| 메모 서비스 상담 | current | 571.735 | 0 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan |
| 메모 서비스 상담 | A | 316.843 | 29843 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan → Subquery Scan → Result |
| 메모 서비스 상담 | fused | 505.191 | 0 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan |
| 메모 서비스 상담 | fused_direct | 448.979 | 0 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan |
| 반복 문장 | current | 102.510 | 0 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan |
| 반복 문장 | A | 154.179 | 2440 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan → Subquery Scan → Result |
| 반복 문장 | fused | 98.994 | 0 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan |
| 반복 문장 | fused_direct | 108.761 | 0 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan |
| 45자 | current | 24.745 | 0 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan |
| 45자 | A | 212.299 | 2440 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan → Subquery Scan → Result |
| 45자 | fused | 20.268 | 0 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan |
| 45자 | fused_direct | 19.329 | 0 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan |
| LIKE %est | current | 375.076 | 0 | Aggregate → Gather → Seq Scan |
| LIKE %est | A | 749.116 | 100000 | Aggregate → Seq Scan → Subquery Scan → Result |
| LIKE %est | fused | 370.959 | 0 | Aggregate → Gather → Seq Scan |
| LIKE %est | fused_direct | 332.734 | 0 | Aggregate → Gather → Seq Scan |
| NULL 길이 인자 | current | 0.007 | 0 | Aggregate → Result |
| NULL 길이 인자 | A | 249.776 | 29843 | Aggregate → Bitmap Heap Scan → Bitmap Index Scan → Subquery Scan → Result |
| NULL 길이 인자 | fused | 0.008 | 0 | Aggregate → Result |
| NULL 길이 인자 | fused_direct | 0.009 | 0 | Aggregate → Result |

## 5. 정확성·적용 범위

- 고객10만 행에서 9조건×count/목록300×4경로의 예열·측정·EXPLAIN 준비 호출이 모두 평문과 일치했다. NULL은 원본 표 변경 없이 판정 길이 인자만 NULL로 전달한 기존 회귀 방식이다. 실제 nullable 열 관리형 쓰기·혼합 SQL/커서 재검증은 이번 범위가 아니다.
- 기존 fixture 메모를 이어 붙인 129/130/257/500/1000자 파생값에서 contains/startsWith/endsWith/45자/반대 순서/값보다 긴 질의를 현재·결합·결합+cast로 대조해 90건 통과. 큰 배열의 **정확성** 검사이며 그 조건의 성능은 측정하지 않았다.
- 함수 설치문·고정 source hash fda5d6db9964863f74a5b421ae1357db05f61a35d50f2bee4226fbc045a6a056, 7회 원측정, 전체 EXPLAIN은 result.json/fused.sql/fused_direct.sql에 보존. 동일 세션 PID 24060, JIT=on, parallel=2.
- 자기 스키마 삭제=true, 추가 정확성 스키마 삭제=true. 다른 작업자 락·제품·보호 표는 변경하지 않았다.
- 측정 실행: 적재 470.7초, 측정 포함 실행 2026-09-29T08:47:09.224Z–2026-09-29T08:57:28.916Z. 함수 SQL과 원측정 JSON은 같은 디렉터리에 보존한다.

최종 채택 판정은 아래 결론에 기록한다. 로컬 파생 fixture 연구이며 운영 보장·보안 인증이 아니다.

## 6. 최종 판단

| 안 | 판정 | 근거 |
|---|---|---|
| 기존 A의 외부 CASE/SubPlan 선행 판정 | 채택 불가 | 반복·45자·NULL 퇴행 재현. LIKE %est count에서 현재 Gather+병렬 Seq Scan(loops3)이 A에서는 직렬 Seq Scan+SubPlan100,000회로 바뀜: 이번 서버 EXPLAIN375.08→749.12ms. 중복 계산 외에 병렬 계획도 잃음 |
| 일반 단일 탐색 식 결합 | 이번 제품 채택 불가(보류) | 반복 count120.79→100.04ms 개선, 그러나 주소203.06→210.77ms(+3.8%),45자18.97→22.14ms(+16.7%). 병행 부하라 이 차이를 고유한 퇴행으로 확정하지도, 무퇴행으로 지우지도 못함 |
| 결합+직접 bigint cast | 후속 후보, 이번 미채택 | 주소169.75/메모503.84/이메일533.66ms로 현재보다 개선;45자19.43ms는 현재18.97ms와 비슷함. 직접 cast만의 대조 경로가 없어 개선분을 식 결합에 귀속할 수 없음. PG18 이외 직접 cast 호환 미검증 |

NULL의 새 함수는 현재와 같은 Aggregate→Result 계획(서버0.008/0.009ms 대 현재0.007ms)으로 즉시 종료한다. 클라이언트 중앙값0.19→0.48ms 차이는 남았으나 A의29,843행 전수 판정과는 실행 작업 자체가 다르다. 45자도 새 함수 SubPlan0회로 원인을 제거했다.

형태를 더 복잡하게 만들거나 창 수·검색어별 예외를 넣지 않는다. 얻은 결론은 **사전 첫 등장 패스 자체를 없애야 한다**는 것이며, 그 다음 PL 식 결합은 기능상 가능하지만 확실한 순이득은 아직 입증되지 않았다. 전체 제품 API·현재+cast 단독 대조 및 병행 부하 없는 반복을 하지 않은 상태에서 실사용 코드로 승격하지 않는다.

## 7. 현재+cast 단독 추가 대조

기존 §6의 원인 분리 부족을 확인하기 위해 현재 제품 함수의 해시 변환 **두 곳만** hex→bit→bigint에서 bytea→bigint 직접 형변환으로 교체했다. 식 결합·반복·조기 종료·함수 속성·COST는 바꾸지 않았다. 제품 코드는 변경하지 않았다.

**락 없이, 병행 부하 중**, 동일 연결(PID 50432)에서 각 조건 예열2+교차7, 매 반복 시작 경로를 교대했다. 아래 절대값은 참고이며 직전 실험과 절대값을 직접 비교하지 않는다. 이번 서버 18.4; **현재+cast는 PostgreSQL 18 이상을 요구한다**. 현재 경로의 기존 버전 지원 범위는 이 연구로 새로 검증하지 않았다.

| 조건 | 조회 | 정답 수 | 현재 ms | 현재+cast ms | 변화율 | 7쌍 중 cast가 빠른 횟수 | 버전 조건 |
|---|---|---:|---:|---:|---:|---:|---|
| 주소 세종대로 | count | 16574 | 177.357 | 165.655 | -6.6% | 7/7 | cast: PG18+ |
| 주소 세종대로 | list300 | 16574 | 174.557 | 161.622 | -7.4% | 7/7 | cast: PG18+ |
| 메모 서비스 상담 | count | 29843 | 394.273 | 368.716 | -6.5% | 7/7 | cast: PG18+ |
| 메모 서비스 상담 | list300 | 29843 | 395.281 | 371.125 | -6.1% | 7/7 | cast: PG18+ |
| 이메일 biz.test 끝 | count | 26598 | 450.216 | 435.250 | -3.3% | 7/7 | cast: PG18+ |
| 이메일 biz.test 끝 | list300 | 26598 | 455.411 | 422.436 | -7.2% | 7/7 | cast: PG18+ |
| 드문 푸른달 | count | 101 | 1.269 | 1.159 | -8.7% | 6/7 | cast: PG18+ |
| 드문 푸른달 | list300 | 101 | 1.273 | 1.290 | 1.3% | 4/7 | cast: PG18+ |
| 역순 상담서비스 | count | 0 | 0.376 | 0.370 | -1.6% | 4/7 | cast: PG18+ |
| 역순 상담서비스 | list300 | 0 | 0.339 | 0.358 | 5.8% | 1/7 | cast: PG18+ |
| 반복 문장 | count | 2440 | 81.019 | 75.273 | -7.1% | 7/7 | cast: PG18+ |
| 반복 문장 | list300 | 2440 | 81.181 | 74.316 | -8.5% | 7/7 | cast: PG18+ |
| 45자 | count | 0 | 17.906 | 16.981 | -5.2% | 7/7 | cast: PG18+ |
| 45자 | list300 | 0 | 17.558 | 17.090 | -2.7% | 6/7 | cast: PG18+ |
| LIKE %est | count | 100000 | 337.619 | 320.027 | -5.2% | 7/7 | cast: PG18+ |
| LIKE %est | list300 | 100000 | 31.246 | 31.193 | -0.2% | 5/7 | cast: PG18+ |
| NULL 길이 인자 | count | 0 | 0.194 | 0.230 | 18.8% | 2/7 | cast: PG18+ |
| NULL 길이 인자 | list300 | 0 | 0.189 | 0.188 | -0.5% | 4/7 | cast: PG18+ |

모든9조건의count·목록300을 독립 평문 정답과 매번 대조했고 모두 일치했다. LIKE %est는 기존 실험과 동일하게 endsWith est 경로, NULL은 길이 인자 NULL이다. 저장물·전송 키·키 파생은 동일하다. 목록은 직접 SQL ID300개이며 제품 prefix/fallback·반환 필드 인증 복호화는 포함하지 않는다.

- 원측정·EXPLAIN·현재 함수 전문과 source hash: bench/results/2026-09-29-next-cast-astra/result.json
- 비교 함수: bench/results/2026-09-29-next-cast-astra/current_cast.sql
- 시작 2026-09-29T09:03:56.817Z, 종료 2026-09-29T09:11:15.649Z, 파생100,000행 적재 381.4초; 자기 임시 스키마 삭제=true.

### 추가 판정: PostgreSQL 18 이상에서 채택 후보

판정 함수를 실제로 많이 실행하는 6조건(주소·메모·이메일·반복·45자·LIKE)의 count·목록 **12개 중앙값 모두 감소**했다. LIKE 목록의 사실상 동률(-0.17%)을 제외한 11개는 **2.7~8.5% 감소**했다. 12개 중10개는7쌍 모두 cast가 빨랐고,45자 목록은6/7,LIKE 목록은5/7이다. 따라서 해시 변환만의 교체는 **채택 후보**로 올린다. 기존 단일 탐색 식 결합의 보류 판정은 유지한다.

모든18개가 개선됐다는 뜻은 아니다. 드문값 목록은1.273→1.290ms(+0.017ms,cast승4/7),0후보 목록은0.339→0.358ms(+0.020ms),NULL count는0.194→0.230ms(+0.036ms)였다. 0후보·NULL은 EXPLAIN상 판정 함수를 실행하지 않으므로 그 차이를 cast 퇴행으로 귀속할 수 없다. NULL은 양쪽 모두 Result 즉시 종료,LIKE count는 양쪽 모두 Gather+병렬 스캔을 유지했다.

함수 본문이 직전 실험과 동일하고, 새 함수 본문은 직접 cast 두 곳 외에는 같음을 파일 단언으로 확인했다(스키마 이름이 달라 설치문 전체 hash는 다름). 결과 동일성 검사는 이번18조회×2경로에서 모두 통과했다. 보안 관련 저장·전송 구조를 변경하지 않았지만 이 성능 실험 자체가 별도의 보안 인증은 아니다.

**조건:** PostgreSQL 18 이상 요구를 받아들이는 경우의 후보이며, 제품 반영·커밋은 하지 않았다. 기존 버전용 분기나 호환 계층은 제안하지 않는다. 절대값·전체 API200ms 달성은 보장하지 않으며, 이번 추가 연구는 여기서 종결한다.

최종 코디네이터 판정: 직접 cast의 약 3~8% 개선만으로 PostgreSQL 14~17을 사용하는 관리형 DB의 지원 범위를 좁히지 않고, 서버 버전별 두 경로도 추가하지 않으므로 제품 적용은 연기로 종결한다.
