# bench/

측정·공격 시뮬레이션 스크립트와 결과(`results/`)다. 공통 규칙은 [docs/measurement.md](../docs/measurement.md)와 [docs/attack-simulation.md](../docs/attack-simulation.md)에 있다. 결과는 로컬 일회용 DB의 관찰이며 운영 보장·보안 인증이 아니다.

현재 DB 도장 판정 구현의 측정은 [R9 보고](results/2026-09-29-r9/report-ko.md)와 [스크립트](r9/)에 있다. 정렬/무작위 물리 순서의 제품·연구·평문 교차 측정, 후보 수, words/single 누출·용량, 쓰기 비용과 드라이버 흐름을 기록한다. 이전 결과는 해당 시점 구현의 증거로 보존한다.

## 일회용 DB 규칙

- `127.0.0.1:56439`, 사용자 `sealql_test`, 데이터 디렉터리 `.local/pg-test`만 쓴다. 기동: `pg_ctl -D .local/pg-test -o "-h 127.0.0.1 -p 56439" -l .local/pg-test.log start -w -t 60`.
- 모든 DB 스크립트는 `test/disposable.ts`의 `assertDisposable`(데이터 디렉터리·소유자 확인)과 포트 확인을 먼저 호출한다. `standard-next/common.ts`의 `guard()`가 이를 감싼다.
- 운영 DB와 5432 포트는 쓰지 않는다. 원본 `bench_realistic_100k`는 읽기만 하고, 파생 스키마(`bench_standard_next_100k` 등)에만 쓴다. 스크립트가 만든 임시 객체는 끝에 지운다.
- 실행: `rtk proxy node --import tsx bench/<폴더>/<스크립트>.ts`.

## fixture

- `bench_realistic_100k`: 고객·티켓 각 100,000행의 합성 업무 데이터. 필드 `name`, `phone`, `address`, `memo`, `email`, `company`마다 평문(`*_plain`)과 정규화 평문(`*_norm`)이 있다. 티켓 i는 고객 i를 참조한다. 시드 `0x20260924`.
- 평문 생성기: [fixture/generator.ts](fixture/generator.ts). 원래 적재 스크립트에서 평문 부분만 추출했다. [fixture/load.ts](fixture/load.ts)는 같은 시드와 행 순서로 평문 스키마를 재현하거나 `--verify`로 전수 대조한다.
- 새 형식 fixture는 원본의 `*_plain`에서 `standard-next/load.ts`로 파생한다.

## 처음부터 환경 만들기

PostgreSQL 18의 `initdb`와 `pg_ctl`이 PATH에 있어야 한다. 아래 명령은 저장소 루트에서 실행한다. `.local/pg-test`가 이미 있다면 초기화하지 않는다. 새 클러스터는 로컬 전용이며, `initdb -U`가 `sealql_test` 역할을 초기 슈퍼유저로 만들므로 별도 역할 생성이나 권한 부여가 필요 없다. 이후 스크립트는 데이터 디렉터리와 `current_user`가 이 값인지 확인한다.

```powershell
rtk proxy initdb -D .local/pg-test -U sealql_test -E UTF8 --locale=C --auth-local=trust --auth-host=trust
rtk proxy pg_ctl -D .local/pg-test -o "-h 127.0.0.1 -p 56439" -l .local/pg-test.log start -w -t 60
rtk proxy node --import tsx bench/fixture/setup-extension.ts
rtk proxy node --import tsx bench/fixture/load.ts
rtk proxy node --import tsx bench/fixture/load.ts --verify
rtk proxy node --import tsx bench/standard-next/load.ts
rtk npm test
```

현재 일회용 클러스터를 읽기 전용으로 확인한 값은 PostgreSQL 18.4, UTF8, DB 로캘 `C`/`C`, 사용자 `sealql_test`, DB `postgres`, 필수 확장 `pg_trgm` 1.6이다. `pgstattuple` 1.5도 설치돼 있지만 평문 fixture 적재에는 필요하지 않다. 확인 쿼리는 `show server_version`, `show server_encoding`, `show data_directory`, `show port`, `select datcollate, datctype from pg_database where datname=current_database()`, `select extname, extversion from pg_extension`이다. 필수 설정은 이 로캘·인코딩·포트이며, 다른 서버 설정 변경은 필요하지 않다.

`load.ts`는 대상 스키마가 이미 있으면 거부한다. 다른 이름으로 재현할 때는 `--schema <name>`을 쓰고, 그 스키마의 모든 행을 읽어 비교할 때는 `--schema <name> --verify`를 쓴다. 원본 `bench_realistic_100k`가 있는 기존 클러스터에서는 `--verify`만 실행한다. 원본은 읽기만 하며, 검증용 임시 스키마는 확인 후 별도로 삭제한다. `standard-next/load.ts`는 이 평문 원본에서 제품 형식 `bench_standard_next_100k`를 파생한다.

## 공개 말뭉치

- NSMC(Naver sentiment movie corpus) `ratings.txt`: <https://github.com/e9t/nsmc>. 로컬 위치 `.local/ratings.txt`(Git 제외), 200,000행.
- SHA-256 `7d1d8e66323eb5a64feb2e299178f58827d8302111c434195dfeef48506e1256`.
- 메모리 시뮬레이션에만 쓴다. DB 적재는 승인되지 않았다.

## 스크립트 → 결과 → 결정

| 스크립트 | 결과 (`results/`) | 결정 |
|---|---|---|
| `standard-review/corpus-sim2.ts`, `corpus-sim3.ts` | `standard-review-2026-09-26/corpus-sim2.json`, `corpus-sim3-long.json` | [004](../docs/decisions/004-token-layout-16bit.md), [005](../docs/decisions/005-skip-grams-default-on.md) |
| `standard-review/frequency-attack.ts`, `known-row-attack.ts` (옛 벤치 토큰, 출력은 콘솔) | `2026-09-27-layout-attack/scale-ko.md`에서 재현 | [004](../docs/decisions/004-token-layout-16bit.md) |
| `standard-review/product-basic-bench.ts`, `product-token-attack.ts` | `standard-product-*-2026-09-27.json`, `standard-core-implementation-2026-09-27.md` | [003](../docs/decisions/003-field-cipher-key-cache-aad.md), [010](../docs/decisions/010-security-claim-limits.md) |
| `standard-next/probe.ts`(원본 스키마 확인), `load.ts`, `verify-all.ts`, `matrix.ts`, `count.ts`, `join.ts`, `mixed.ts`, `crud.ts`, `storage.ts`, `stages.ts`, `explain.ts`, `db-attack.ts`, `old-column.ts`, `old-oracle.ts`, `report-data.ts` | `2026-09-27-standard-next/` ([절차](standard-next/README.md)) | [002](../docs/decisions/002-fixed-keys-no-db-policy.md), [006](../docs/decisions/006-query-engine.md) |
| `standard-next/sqlplan-probe.ts`, `sqlplan-sweep.ts`, `sqlplan-and.ts` | `2026-09-27-standard-next-sqlplan/` | [006](../docs/decisions/006-query-engine.md) |
| `standard-next/sqlplan-sweep.ts`, `matrix.ts` (전후) | `2026-09-27-candidate-batching/` | [006](../docs/decisions/006-query-engine.md) |
| `standard-next/layout-attack.ts` | `2026-09-27-layout-attack/` | [004](../docs/decisions/004-token-layout-16bit.md), [005](../docs/decisions/005-skip-grams-default-on.md) |
| `standard-next/combined-gin.ts` | `2026-09-27-combined-gin/` | [005](../docs/decisions/005-skip-grams-default-on.md), [007](../docs/decisions/007-multicolumn-gin-not-combined-array.md) |
| `standard-next/multicolumn-gin.ts` | `2026-09-27-multicolumn-gin/` | [007](../docs/decisions/007-multicolumn-gin-not-combined-array.md) |
| `standard-next/multicolumn-product-fixture.ts` | `2026-09-27-product-multicolumn-gin/` | [007](../docs/decisions/007-multicolumn-gin-not-combined-array.md) |
| `standard-next/skip-write-cost.ts` | `2026-09-27-skip-write-cost/` | [005](../docs/decisions/005-skip-grams-default-on.md) |
| `verify-core/*` (V1 정확성·무결성, `v2-attack.ts`, `v3-*.ts`) | `2026-09-27-core-verification/v1`, `v2`, `v3` | [006](../docs/decisions/006-query-engine.md), [010](../docs/decisions/010-security-claim-limits.md) |
| `drizzle-poc/*` (시제품 H1–H7, 반증 E1–E7) | `2026-09-27-drizzle-poc/`, `2026-09-27-drizzle-falsify/` | [008](../docs/decisions/008-drizzle-integration.md) |
| `standard-next/g0-token-placement.ts` | `2026-09-27-g0-token-placement/` | [008](../docs/decisions/008-drizzle-integration.md) |
| `gate-x1x2/*` | `2026-09-27-gate-x1x2/` | [008](../docs/decisions/008-drizzle-integration.md) |
| `drizzle-design/*` (타입 실험 `tsc -p bench/drizzle-design`, drizzle-kit 실험, 트리거 초안) | 결과 파일 없음 | [013](../docs/decisions/013-drizzle-native-api-implemented.md) |
| `verify-native/scale-scope-b-*.ts` (1억 행 중 복제본 1벌을 다른 scope로 재암호화하고 21개 조회·AND/OR 200건·count를 측정) | `2026-09-27-native-scale-100m/scope-b/` ([보고](results/2026-09-27-native-scale-100m/scope-b/report-ko.md)) | 제품 결정 변경 없음 |

## 스크립트 없이 결과만 보존한 것 (재현 불가)

기각된 연구와 이전 형식의 측정이다. 코드는 지웠고 결과만 결정의 근거로 남긴다.

| 결과 (`results/`) | 결정 |
|---|---|
| `standard-review-2026-09-26/stages.json`, `std-matrix-baseline.json`, `token-leakage.json`, `corpus-sim.json` | [001](../docs/decisions/001-search-hmac-pieces-gin-verify.md), [002](../docs/decisions/002-fixed-keys-no-db-policy.md), [003](../docs/decisions/003-field-cipher-key-cache-aad.md), [006](../docs/decisions/006-query-engine.md) |
| `keyless-snapshot-length-attack-ko.md`, `.json`; `confidentiality-diverse-100k/score-report*.json`, `audit-report.json`; `reconstruction-blind/v2-evaluation-ko.md` | [010](../docs/decisions/010-security-claim-limits.md) |
| `posting-pages-research-ko.md`, `posting-pages-v2-research-ko.md`, `posting-pages-supervisor-verdict-ko.md`, `lightweight-report-ko.md` | [011](../docs/decisions/011-rejected-research-lines.md) |

큰 원시 파일(`*.jsonl`, `*.gz`)은 Git에 넣지 않는다.
