# 008. Drizzle 통합 방식

- 상태: 연구·실측 기록. **채택 설계(부모 테이블 숨은 칸 + 트리거, `sealedTable`)는 [012](012-drizzle-companion-and-column-options.md)로 대체됨.** (원 상태: 설계 확정 2026-09-27, 사용자 결정.) **구현 완료** ([013](013-drizzle-native-api-implemented.md)). 현재 제품은 companion 테이블과 `sealql/drizzle/v0.45`의 `createSealed`/`register`/`insert`/`update`/`upsert`/`open`/`findMany`/`search` API다. 공개 API 계약은 [013](013-drizzle-native-api-implemented.md)과 [docs/llm-integration.md](../llm-integration.md)에 있다.

## 결정

- 앱은 Drizzle 문법(`db.insert/update/select/query/transaction/execute`)을 그대로 쓴다. SealQL은 데이터가 들어가는 지점(`seal`, `patch`)과 나오는 지점(`open`)에만 비동기 도우미 한 겹을 둔다. 검색·count만 전용 호출(`findMany`, `count`, `search`)이다.
- 저장 구조: **부모 테이블의 Drizzle 미선언 토큰 칸** + 테이블별 **BEFORE 트리거**. `seal`/`patch`가 만든 쓰기 봉투(scope, row, 필드 번호, 토큰, 저장용 암호문)를 트리거가 검사하고 토큰 칸으로 옮긴다. companion 테이블은 없앤다. 부분 검색 토큰 칸은 다중 컬럼 GIN([007](007-multicolumn-gin-not-combined-array.md))을 유지한다.
- 암호문 형식, AAD(행 결속 포함), 토큰 계산, 16비트, 건너뛴 조각 기본 켬, 재확인 필수는 **바꾸지 않는다.**
- `drizzle()` 인스턴스와 드라이버를 감싸지 않는다. 암호화 테이블이 아닌 쿼리에는 비용과 제약이 없다.
- 마이그레이션은 `drizzle-kit generate` + 커스텀 SQL + `migrate`만 지원한다. 암호화 테이블이 있는 DB에는 **`push`/`pull`을 지원하지 않는다.**

## 근거

**공식 창구의 한계** (drizzle-orm 0.45.3 소스 대조와 시제품, [시제품 보고](../../bench/results/2026-09-27-drizzle-poc/report-ko.md)):

| 가설 | 판정 |
|---|---|
| H1 Node·workerd에서 동기 AES-GCM(AAD)·HMAC-SHA-384·HKDF 가능 | 확인(가용성) |
| H2 행 ID 없이 값 하나로 암호문을 만들어도 보안 손실이 제한적 | 기각. 같은 scope 안 암호문 교체가 성공한다(E7) |
| H3 토큰을 부모 테이블 값 안에 두고 `where`와 섞기 | 부분 확인. `db.execute` 원시 결과는 `fromDriver`를 타지 않음 |
| H4 scope를 AsyncLocalStorage로 동기 창구에 전달 | 확인(전달). 호출 형태에 따라 유실(E3) |
| H5 드라이버 래핑으로 비동기 암·복호화 | 부분 확인. 파라미터가 어느 열의 값인지는 SQL 해석 없이 알 수 없고 계산식 결과는 열 식별 불가 |
| H6 재확인은 어떤 공식 창구로도 Drizzle 쿼리 안에 숨길 수 없다 | 확인(소스). 검색은 전용 호출 |
| H7 관계형 쿼리 중첩 결과에 `fromDriver` 적용 | 확인 |

- 공식 훅·미들웨어가 없다. `customType`의 `toDriver`/`fromDriver`는 **동기**이고 값 하나만 받는다. SealQL 암호화는 WebCrypto라 비동기이고 AAD에 행 ID와 scope가 필요하다.
- `like`/`ilike`는 `toDriver`와 타입 검사를 모두 통과한다(bytea LIKE는 조용히 0건). 문서로 경고한다.
- `pg-proxy` 드라이버는 트랜잭션을 지원하지 않는다. 드라이버 래핑은 SQL 해석이 필요해 취약하다.

**반증 실험 E1–E7** ([보고](../../bench/results/2026-09-27-drizzle-falsify/report-ko.md)):

| 실험 | 결과 |
|---|---|
| E1 | 동기 암호 출력이 WebCrypto와 바이트 단위로 같다. 1만 행×6필드 동기 복호화 Node 1,962 ms, workerd 930 ms. 배포 CPU 한도 초과 여부는 미판정 |
| E2 | select·부분 선택·join·returning·prepared·관계형·트랜잭션에는 `fromDriver` 적용. `db.execute` 원시 결과에는 미적용(기각 조건 발생) |
| E3 | `await als.run(scope, () => query)`처럼 thenable을 문맥 밖에서 기다리면 문맥 유실 |
| E4 | companion + 트리거: `ON CONFLICT DO UPDATE SET x=excluded.x`가 갱신에 실패하고, 원시 `UPDATE ct=...`가 트리거를 통과해 토큰·암호문 불일치. 인라인 토큰 검색 SQL은 0.891 → 0.489 ms |
| E5 | 복합 타입·연산자로 모든 비검색 연산을 막을 수 없다(명시 캐스트로 우회). 복합 `=`는 오탐을 반환 |
| E6 | CHECK는 평문·다른 scope는 거부하지만 같은 형식의 위조값은 통과. DB CHECK로 암호 인증 불가 |
| E7 | 행 ID 없는 AAD는 같은 scope의 다른 행으로 옮겨도 복호화 성공. 스냅샷 공격 점수는 같음(7.80% / 45.75% / 19.20%) |

**저장 위치 G0** ([보고](../../bench/results/2026-09-27-g0-token-placement/report-ko.md)): 부모 테이블에 **선언된** 토큰 칸은 20행 `select *`를 0.5122 → 3.6671 ms(**+616%**)로 만들었다. 토큰 칸 제외 선택은 −1.4%. 부모 토큰 검색 SQL은 companion보다 빠르고(21개 중 대부분 30–40%), 1,000건 insert는 629.55 → 445.16 ms였다. 그래서 토큰 칸을 Drizzle에 **선언하지 않는다**(Drizzle은 선언된 칸만 명시 목록으로 조회한다).

**게이트 X1·X2** ([보고](../../bench/results/2026-09-27-gate-x1x2/report-ko.md)):

- X1: 단건·배열 insert, patch(값·NULL), `set: v` upsert, `DO NOTHING`, 롤백·savepoint, 행·scope 변경 거부(`SQL01`), 봉투 없는 쓰기(`SQL02`), 다른 행·다중 행(`SQL03`) 확인. 0행을 맞춘 patch는 트리거가 돌지 않아 `rowCount=0`(평범한 Drizzle update와 같음, 쓰인 것이 없으므로 불일치 없음). `excluded` upsert는 `SQL02`. 실제 COPY 프로토콜은 미확인.
- drizzle-kit: 미선언 칸이 있어도 `generate`는 "변경 없음"으로 안전. `tablesFilter`·`schemaFilter`를 둬도 `push --force`가 전용 스키마 DROP을 시도했다. 그래서 push/pull 제외 설정을 안내하지 않고 미지원으로 둔다.
- X2(1,000건, companion 대비): insert 0.84×, patch 0.62×, delete 0.56×. 검색 후보 SQL은 정확 일치 직접 조회 0.28–0.32 ms, 부분 검색은 256행 prefix 경로 0.54–2.13 ms. 직접 조회는 `sub_mid`·`ends`·`word_boundary`류에서 38–66 ms로 나빴다. `sub_long`(4.90 vs 4.66)과 `and6`(9.33 vs 8.98)만 약 5% 느렸다. 후보 SQL만 잰 값이라 제품 전체 경로로 다시 판정한다.

## 기각안

| 안 | 기각 이유 |
|---|---|
| 동기 `customType` 안의 투명 암·복호화(행 결속 제거) | **보안 약화**. 같은 scope 안 암호문 교체가 성공한다(E7). 사용자 원칙: 보안과 편의를 교환하지 않는다 |
| 드라이버·`drizzle()` 래핑 | SQL 해석 필요, 계산식 결과 열 식별 불가, 버전 민감. 암호화 없는 쿼리에도 비용 |
| `pg-proxy` | 트랜잭션 불가 |
| 부모 테이블에 선언된 토큰 칸 | `select *` +616%(G0) |
| companion + 트리거 | `ON CONFLICT DO NOTHING`/`excluded`에서 조용한 불일치(E4, 설계 재검증) |
| AsyncLocalStorage로 scope 전달 | 호출 형태에 따라 문맥 유실(E3) |
| 도메인·복합 타입·CHECK로 오용 차단 | 우회 가능(E5, E6). 대신 브랜드 타입 `Sealed<T>`로 컴파일 오류 |
| `tablesFilter`로 push 제외 안내 | X1에서 반박 |

## 대체 관계

- 대체하는 것: 옛 `defineSealed`/`bindSealed`/`forScope`/`searchWithQuery` 설계. companion 테이블 채택은 [012](012-drizzle-companion-and-column-options.md)를 거쳐 [013](013-drizzle-native-api-implemented.md)로 구현 완료됐다.
- 관련: [003](003-field-cipher-key-cache-aad.md), [007](007-multicolumn-gin-not-combined-array.md), [009](009-scope-and-non-goals.md), [013](013-drizzle-native-api-implemented.md).
