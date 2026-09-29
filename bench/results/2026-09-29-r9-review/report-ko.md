# R9 검토 반영 보고

## 범위·조건

`a15f85a` 검토의 발견 1–14를 반영했다. 원본 fixture 및 연구·다른 검증 스키마는 읽기만 했고, DB는 가드와 포트 검사를 통과한 일회용 56439만 사용했다. 측정 락을 단독 보유한 동안 빌드·DB 시험·측정을 순차 실행했다.

함수/조회/쓰기 모두 예열 2회, 순서를 교차한 7회 중앙값이다. 조회는 기존 제품 파생 10만 행(`test_r9_performance_main`, 무작위 물리 순서, 정규화된 원본 값)을 같은 테이블·키로 비교하며 매번 평문 count·ID·6개 반환 필드를 대조했다. 쓰기는 원본 `*_plain` 100행을 별도 버전별 임시 스키마에 넣어 대소문자·공백을 포함해 복호화 결과를 전수 대조했다. 두 데이터 조건을 같은 것으로 취급하지 않는다.

## 발견별 처리

| 발견 | 결과 |
|---|---|
| 1·14 | 창별 전진 커서 유지, 큰 배열 이진 탐색, NULL/음수/범위 밖·역행 위치 오류; 긴 근접 불일치 자동 시험 |
| 2·4 | LIKE 정수 프로그램·평평한 위치 배열, 가장 짧은 목록에서 literal 시작점 열거; 창별 커서 주석 정정 |
| 3 | 이전 제품과 insert/reindex 행당 비용 측정, 설치 순서 옆 명시; 동기 SHA 후보는 이득 기준 미달로 기각 |
| 5·6·7 | companion 삭제는 모든 검색 필드 값 NULL, flags는 커서 위치, 관찰된 singleton 키의 이후 행 노출로 문서 정정 |
| 8 | 001·004·006·014에 대체 상태 줄만 추가, 옛 본문 보존 |
| 9 | limit201 및 최상위 OR limit100/201, 모든 keyset 페이지를 평문과 대조 |
| 10·11 | count 미지 옵션 일괄 거부, 토큰·도장·평문 판정의 공백 정규화 공통화 |
| 12 | SET 제거 후보 별도 측정; 일부 count 이득과 목록/OR 변동이 섞여 search_path 고정 유지 |
| 13 | 실제 디스크 정렬 확인 후 ID만 정렬하고 proof를 읽도록 수정; temp I/O 제거 |

## 긴 값 함수 판정

| 조건 | 값/질의 글자 | 이전 ms | 최종 ms | SET 제거 후보 ms |
|---|---:|---:|---:|---:|
| short-hit | 49/2 | 0.309 | 0.305 | 0.303 |
| short-miss | 49/6 | 0.280 | 0.289 | 0.270 |
| repeat-near-contains | 4002/4 | >1500 (시험 중단) | 33.462 | 33.524 |
| repeat-near-like | 4002/260 | 182.343 | 40.519 | 39.142 |
| long-literal-like | 2802/2050 | 654.379 | 27.020 | 27.222 |

출처: [functions.json](functions.json), [함수 스크립트](../../r9/review-functions.ts). SQL 왕복, 호출당 후보 1행·boolean 1행, 인증 복호화 없음. 이전 contains는 시험 측 제한 시간에 걸려 7회 중앙값이 없다. 실제 제품에는 새 제한을 넣지 않았다. 긴 값은 기존 fixture 문자 반복으로 파생했다.

최종 탐색은 128칸 이하 배열에서 DB 내장 C 탐색을 한 번 사용하고 큰 배열에서는 이진 탐색한다. 128은 내부 탐색 전환 상수이며 결과나 작업량 상한이 아니다. 순수 이진 및 이진+마지막16칸 C 탐색과 비교한 뒤 더 단순하고 빠른 분기를 선택했다. 첫 창은 스칼라, 후속 창은 전진 배열 커서다. [순수 이진](search-pure-binary.json), [배열 커서 비교](search-array-cursors.json), [최종 분기 선택 비교](search-lookup-candidates.json)는 중간 후보 증거이고 최종 제품 수치가 아니다.

## 대표 8조건

| 조건 | 연산 | 이전 SQL ms | 최종 SQL ms | 배율 | 이전 전체 ms | 최종 전체 ms | SET 제거 SQL ms |
|---|---|---:|---:|---:|---:|---:|---:|
| exact_common | count | 62.60 | 60.23 | 0.96 | 63.51 | 61.09 | 58.87 |
| exact_common | list | 3.35 | 3.27 | 0.98 | 63.65 | 66.13 | 3.39 |
| sub_common_memo | count | 261.08 | 309.34 | 1.18 | 262.17 | 310.85 | 300.83 |
| sub_common_memo | list | 128.77 | 108.96 | 0.85 | 194.11 | 174.58 | 110.95 |
| starts | count | 135.32 | 143.35 | 1.06 | 136.30 | 144.27 | 135.46 |
| starts | list | 36.00 | 21.87 | 0.61 | 100.95 | 83.70 | 21.98 |
| ends | count | 522.59 | 673.63 | 1.29 | 523.96 | 675.08 | 649.37 |
| ends | list | 121.05 | 96.49 | 0.80 | 185.70 | 156.64 | 99.42 |
| and2 | count | 226.98 | 265.79 | 1.17 | 228.39 | 267.24 | 256.42 |
| and2 | list | 104.93 | 89.41 | 0.85 | 166.64 | 150.95 | 90.91 |
| and6 | count | 30.68 | 37.08 | 1.21 | 33.28 | 40.01 | 35.19 |
| and6 | list | 22.15 | 25.99 | 1.17 | 87.15 | 92.00 | 25.76 |
| or2 | count | 138.69 | 138.90 | 1.00 | 139.90 | 140.28 | 143.83 |
| or2 | list | 5.16 | 5.10 | 0.99 | 67.64 | 64.03 | 5.12 |
| sub45 | count | 17.85 | 22.67 | 1.27 | 20.25 | 24.93 | 21.75 |
| sub45 | list | 24.14 | 34.82 | 1.44 | 27.09 | 37.94 | 34.34 |

출처: [search.json](search.json), [API 스크립트](../../r9/review-search.ts). 모든 호출 SQL 1회; count는 스칼라 1행, 목록은 300행(45자 조건은 0행)을 앱에 반환했다. DB 후보 수는 메모 목록 EXPLAIN의 40,097행 외에는 별도 계측하지 않았다. 인증 복호화는 count 0, 목록 1,800필드(6×300), 45자 목록 0으로 코드 기준 추정이며 독립 호출 계측값은 아니다. 전체 시간에는 키 준비와 결과 복호화를 포함한다. 중앙값끼리는 합산하지 않는다. 평문은 정확성 oracle로 실행했고 이번 비교에서 평문 성능 배율은 주장하지 않는다.

메모 목록 EXPLAIN은 이전 40,097개 proof 포함 행의 external merge 14,624kB, temp read/write 492/1,831블록이었다. 수정 후 ID 정렬은 quicksort 1,537kB 메모리, temp read/write 0이다. 300개 최종 행에 필요한 proof를 ID 색인으로 읽는다. EXPLAIN은 별도 1회이며 반복 중앙값이 아니다.

남은 퇴행: count는 커서 상태·손상 위치 검증 비용이 추가되고, 긴 45자 목록은 작은 후보도 ID 정렬 뒤 다시 읽는 비용이 붙는다. 이메일 count 약1.29배, AND6 count 약1.21배, 45자 count 약1.27배·목록 약1.44배를 숨기지 않는다. 최악 비용 개선과 디스크 정렬 제거가 모든 조건의 속도 개선을 뜻하지 않는다.

## 쓰기·reindex

| 버전 | insert ms/행 | reindex ms/행 |
|---|---:|---:|
| pre-r9 | 5.483 | 5.425 |
| r9-before | 15.914 | 18.118 |
| r9-after | 15.796 | 18.200 |

출처: [write-costs.json](write-costs.json), [스크립트](../../r9/review-costs.ts). `pre-r9=f9005bd`, `r9-before=a15f85a`, `r9-after=최종 WebCrypto 유지판`; 같은 원본 100행·6필드, exact16+words substring, batch100/단일 트랜잭션, 각 버전의 실제 색인/증명 열을 설치했다. 전체 API wall time/행이며 SQL·암호 연산별 분해는 하지 않았다. 읽기 함수의 후속 변경은 쓰기 경로를 바꾸지 않았다. 10만 행 적재나 운영 비용으로 외삽하지 않는다.

동기 SHA 후보: 같은 세션의 WebCrypto insert/reindex 15.677/18.013ms 대비 13.887/16.191ms로 11.4%/10.1% 개선에 그쳐 사전 30% 기준 미달로 제외했다([후보 수치](write-costs-sha-candidate.json)). [후보 코드](../../r9/sha-candidate.ts)·[대조 시험](../../r9/sha-candidate.test.ts)·[당시 통합 코드](../../r9/sha-candidate-integration.txt)는 벤치에만 보존하고 제품에는 넣지 않는다. NIST CAVP SHA256ShortMsg 384/416비트 벡터 및 Node의 2,560개 독립 결과와 일치했다([NIST 원본](https://csrc.nist.gov/Projects/cryptographic-algorithm-validation-program/Secure-Hashing)). 고정 라운드/메모리 접근으로 비밀 입력에 따른 분기는 없지만 JS의 일정 시간 실행이나 암호 인증을 뜻하지 않는다. AES·HKDF·HMAC은 기존 WebCrypto 그대로다.

## 재현·게이트

역사 소스는 [prepare-review.mjs](../../r9/prepare-review.mjs)로 별도 폴더에 추출·빌드한다(이미 있으면 거부). 공유 `dist`를 바꾸는 build와 모든 측정 전에 측정 락을 단독 획득해야 한다. 비용·함수 스크립트는 자기 임시 스키마만 만들고 마지막에 삭제한다. API 스크립트는 기존 소유 `test_r9_performance_main`의 함수만 설치하며 기존 연구 테이블은 읽기만 한다. SHA 후보 재현은 별도 복제본에 보존한 통합 코드와 stamp-hash 모듈을 배치해 빌드한 후 동일 비용 스크립트를 실행한다.

| 명령 | 실제 결과 |
|---|---|
| `rtk npm run build` | `node scripts/clean-dist.mjs && tsc -p tsconfig.json`, exit 0 |
| `rtk npm run check` | `tsc -p tsconfig.check.json --noEmit`, exit 0 |
| `rtk npm test` | tests 38 / pass 38 / fail 0 / skipped 0, duration 137015ms |
| `rtk npm run docs:check` | Documentation entry, links, decisions, plans, exports, and shared example references PASS |
| `rtk npm run test:install` | Installed standard consumer compiles with drizzle-orm 0.45.3 / 0.45.2; exit 0 |
| `rtk proxy node --import tsx --test bench/r9/sha-candidate.test.ts` | tests 1 / pass 1 / fail 0 |

전체 시험 실제 출력은 [tests.txt](tests.txt), 패키지 설치 출력은 [install.txt](install.txt)에 있다. 설치 시험이 무시한 upstream Drizzle 선언 진단 70개는 기존 처리이며 제품 진단으로 계산하지 않았다. Node pg·postgres-js·workerd pg 모두 `ok:true,insert:1,count:1,update:1,reindex:1,search:1,substring:1,afterDelete:0`을 출력했다. 트랜잭션 없는 드라이버의 insert/update/upsert/reindex `UNSUPPORTED_DRIVER` 시험도 38개에 포함된다.

코디네이터는 남은 count 1.21–1.29배와 45자 목록1.44배를 기록하고 최악 경우 수정·디스크 정렬 제거를 우선해 확정했다. 추가 튜닝 없이 `050588a`(핵심/회귀 시험), `b5b8550`(postgres-js 자동 흐름)으로 나누어 자기 경로만 커밋했다.

## 미검증·한계

- 이번 수정의 ID-물리 상관≈1 재측정은 하지 않았다. 표는 상관≈0인 같은 소유 테이블의 전후 비교다. 원본 값 10만 행 및 두 물리 배치 최종 검증은 독립 검증 작업에 남는다.
- 실제 Workers/Hyperdrive 배포, 실제 서비스 부하·대규모 자연어 분포는 미검증이다. Node pg·postgres-js·로컬 workerd pg 흐름만 시험했다.
- 저장 형식/키/누출 경계는 바꾸지 않아 전체 기계적 공격 시뮬레이션을 재실행하지 않았다. 관찰된 조각 키가 미래 행에도 적용되는 누출과 기존 미입증 보안 경계는 그대로다.
- 암호문 인증은 적대적 DB의 누락·거짓 predicate를 탐지하지 못한다.

로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.
