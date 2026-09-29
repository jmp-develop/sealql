# 001. 검색은 HMAC 조각 토큰 + GIN + 라이브러리 내부 재확인

- 상태: 확정 (2026-09-27)
- 일부 대체: 앱 내부 조건 재확인은 [015](015-database-search-proofs.md)으로 대체됐다. 아래 본문은 당시 결정 기록이다.

## 결정

- 암호화 필드는 AES-256-GCM으로 저장한다. 검색은 값에서 만든 조각의 **키 있는 HMAC(SHA-384) 절단 토큰**으로 한다.
- PostgreSQL GIN(부분 검색)과 B-tree(정확 일치)가 후보 행을 고른다. 라이브러리가 후보의 조건 필드를 인증 복호화해 실제 조건을 재확인한 뒤에만 결과를 돌려준다. 재확인은 항상 라이브러리 안에서 하며 사용자 코드에 드러나지 않는다.
- 구현은 TypeScript와 WebCrypto만 쓴다. 네이티브 모듈이 없으므로 Node 22 이상과 Cloudflare Workers에서 같은 코드가 돈다.
- 키는 DB로 가지 않는다. 토큰 계산과 복호화는 앱 프로세스 안에서만 한다.

## 근거

조사 17건(상용 제품, 논문, 오픈소스, 국내 솔루션, 커뮤니티, 보안 하드웨어·동형암호, 누출 연구, 필드 구조 분해, GIN, 토큰 설계, 페이지·정렬, 키, ORM)의 결론이 같았다. **기존 PostgreSQL, 임의 위치 부분 검색, 평문에 가까운 속도, 키 없는 DB가 값을 알 수 없는 보안**을 함께 만족하는 것은 이 계열뿐이다.

| 방식 | 부분 검색 | DB 결과가 정확한가 | 비고 |
|---|---|---|---|
| AWS Database Encryption SDK (beacon) | 값 전체 HMAC 절단, 접두는 미리 정의한 조각만 | 아니오. SDK가 오탐 제거 | 절단 길이 = `log2(고유값) − 1` 부근 ([문서](https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/choosing-beacon-length.html)) |
| CipherSweet | blind index. 부분 검색은 정해진 변환만 | 아니오. 앱이 재확인 | [문서](https://ciphersweet.paragonie.com/internals/blind-index) |
| CipherStash (PostgreSQL) | 3글자 조각 블룸 필터 | 텍스트는 오탐 있음·재확인 | 자사 발표 정확 일치 평문 1.2–1.4배 ([문서](https://cipherstash.com/docs/reference/eql/text)) |
| MongoDB QE 부분 검색 (8.2 미리보기) | 길이 범위 안의 **모든 부분 문자열** 토큰화, 필드 최대 60자 | 색인 범위 안에서는 정확 | 제3자 측정 저장 79배·삽입 20배(500문서, 비공식) |
| SQL Server Always Encrypted + enclave | 신뢰 하드웨어 안에서 평문 비교 | 정확 | PostgreSQL에 없음 |
| 평문 `pg_trgm`/`pg_bigm` | 3·2글자 조각 GIN | 아니오. DB가 recheck | 평문 색인도 "후보 + 재확인" |
| 오픈소스(open-mercato PR #123 등) | 3글자 HMAC 32비트 절단 + `int4[]` GIN + 앱 재확인 | 아니오 | 부분 검색을 하는 오픈소스는 모두 조각 HMAC + 재확인 |
| 국내 솔루션(D'Amo, Petra, CubeOne 등) | 일치·범위만, OPE/FPE | — | 암호화 컬럼의 임의 부분 검색은 사실상 미지원 |

- 암호만으로 DB에서 정확한 부분 검색을 하는 방법은 세 가지뿐이고 모두 조건을 깬다: 모든 부분 문자열 저장(비용 폭증, 길이 제한), 신뢰 하드웨어(PostgreSQL 불가), 전용 서버 구조 논문(Chase–Shen 2015, Faber 외 2015 등, PostgreSQL 불가).
- 출시 제품의 부분 검색은 모두 "후보 + 재확인"이다. 차이는 재확인 위치다. DB에 키가 없으므로 SealQL은 앱에서 재확인한다.
- 같은 계열 논문: Goh 2003 Z-IDX(블룸 필터), Dual Blind Indexes(DBSec 2026, 후보 → 복호화 검증).
- 이 결정 뒤의 실측과 누출 측정은 [004](004-token-layout-16bit.md)–[007](007-multicolumn-gin-not-combined-array.md), [010](010-security-claim-limits.md)에 있다.

## 기각안

| 안 | 기각 이유 |
|---|---|
| 순서 보존 암호(ORE/OPE) | 순서가 새어 추론 공격 대상이 된다(Naveed–Kamara–Wright CCS'15). 범위 검색이 필요하면 나중에 구간 토큰으로 따로 검토한다([009](009-scope-and-non-goals.md)) |
| 모든 부분 문자열 저장 | 저장 79배, 삽입 20배(제3자 측정). 필드 길이 제한 |
| 보안 하드웨어(TEE), 동형암호(HE), PIR·ORAM | PostgreSQL에서 불가하거나 너무 느리다. FHE 문자열 검색은 1,000자 텍스트·최대 50자 질의 1회 약 5분(Bonte·Iliashenko, ePrint 2020/931) |
| V2 암호화 posting page | 운영 쓰기가 불가능하고 단일 anchor 실패 사례가 있다([011](011-rejected-research-lines.md)) |
| 키 없는 해시(`SHA-256("강남")`) | 조각 종류가 수백만 개뿐이라 사전 대입으로 즉시 복원된다. 라이브러리는 키 없는 해시 경로를 제공하지 않는다 |
| 2–4글자 n-gram 토큰 | 이름·메모·이메일에서 희귀 토큰 보유 행이 0%(2글자) → 100%(2–4글자)로 폭증 ([token-leakage.json](../../bench/results/standard-review-2026-09-26/token-leakage.json)) |
| pgcrypto(DB 안에서 암·복호화나 `hmac()`) | 키가 DB·로그·`pg_stat_statements`로 간다 |
| CipherStash 같은 전용 연산자·프록시 | 인덱스 누출은 같은 계열이라 보안 이득이 없다. 프록시는 DB 밖 신뢰 구성요소를 추가한다 |
| MongoDB QE 방식(값별 태그 + 카운터 메타데이터) | DB 상태에 의존한다. 쓰기마다 메타데이터 쓰기와 수동 compaction이 필요하다 |

## 대체 관계

- 대체하는 것: 초기 기획의 검색 방식 후보 비교(원 기록 삭제).
- 관련: [004](004-token-layout-16bit.md), [006](006-query-engine.md), [010](010-security-claim-limits.md), [011](011-rejected-research-lines.md).
