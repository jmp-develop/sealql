# bench/

현재 제품의 측정·검증과 기계적 공격 시뮬레이션을 둔다. 공통 측정 규칙은 [measurement.md](../docs/measurement.md), 공격자 조건과 해석은 [attack-simulation.md](../docs/attack-simulation.md)를 따른다. 과거 실험의 근거는 `bench/results/`와 [experiments.md](../docs/experiments.md)에 있으며, 여기에는 실행 가능한 현재 도구만 기록한다.

## 일회용 DB

- DB 스크립트는 `127.0.0.1:56439`, 사용자 `sealql_test`, 데이터 디렉터리 `.local/pg-test`만 사용한다. 운영 DB와 기본 포트 5432에는 접속하지 않는다.
- 연결 직후 [common/db.ts](common/db.ts)의 `disposablePool()` 또는 같은 수준의 가드를 호출한다. 이 함수는 `test/disposable.ts`의 `assertDisposable`과 실제 포트 56439를 모두 확인한다.
- 원본 `bench_realistic_100k`는 읽기 전용이다. 쓰기는 새 스키마에서만 수행하고, 임시 검증이면 끝에 그 스키마만 삭제한다.
- 결과는 로컬 합성 fixture의 관찰이며 운영 성능 보장이나 보안 인증이 아니다.

## 환경 만들기

PostgreSQL 18의 `initdb`와 `pg_ctl`이 PATH에 있어야 한다. 새 클러스터에서 다음 순서로 평문 fixture와 현재 공개 API 형식의 파생 fixture를 만든다. 대상 스키마가 이미 있으면 로더는 덮어쓰지 않고 중단한다.

```powershell
rtk proxy initdb -D .local/pg-test -U sealql_test -E UTF8 --locale=C --auth-local=trust --auth-host=trust
rtk proxy pg_ctl -D .local/pg-test -o "-h 127.0.0.1 -p 56439" -l .local/pg-test.log start -w -t 60
rtk npm run build
rtk proxy node --import tsx bench/fixture/setup-extension.ts
rtk proxy node --import tsx bench/fixture/load.ts
rtk proxy node --import tsx bench/fixture/load.ts --verify
rtk proxy node --import tsx bench/common/load-product-fixture.ts
```

[load-product-fixture.ts](common/load-product-fixture.ts)는 원본 100,000행을 공개 `sealql`·`sealql/drizzle/v0.45` API로 `bench_product_100k`에 파생하고 부모·검색표 행 수와 600개 필드의 인증 복호화 왕복을 확인한다. 일회성 확인은 `--schema test_name --drop`을 붙인다.

## 현재 도구

측정·제품 검증:

- `r9/`: DB 도장 판정의 고정 케이스, 후보·쓰기·검토 측정
- `verify-r9/`: 공개 API 적재, 조회·쓰기·용량·JOIN 독립 검수
- `final-return/`, `followup/r9-impl/`, `followup-wal/`: 기준선, 질의 튜닝, WAL 검증
- `p1-verify/`, `lasthour/r9-impl/`, `lasthour/v-astra/`: 후보 3개 경로와 최종 공개 API 회귀
- `scale-count-million/`: count 전용 10만/100만 행 비교

공격·누출 검증:

- `competitor-sim/`: 결정적 색인 모델의 빈도·알려진 원문·선택 삽입·관찰 공격
- `dummy-sim/`: 전화번호 더미 후보의 충돌 인지 정확 덮개 공격
- `mongo-reeval/`: 상태형 occurrence 색인의 메모리 누출 모델
- `attack-extra/`: 백업·알려진 원문·관찰·시간 채널 추가 공격
- `final-review/r9-impl/`: 현재 제품 토큰의 공격·희귀 토큰·비트 비교
- `lasthour/m1-astra/`: 충돌 인지 전화 복원과 쿼리 관찰 공격

## 새 벤치 추가

1. `bench/<주제>/`에 재실행 가능한 스크립트를 둔다. 공통 코드는 `bench/common/` 또는 그 주제 폴더 한 곳에 두고, 삭제된 실험 폴더를 import하지 않는다.
2. DB를 쓰면 `disposablePool()`을 호출하고 포트 56439를 다시 확인한다. 기존 스키마와 원본 fixture를 수정하지 않으며, 자신이 만든 스키마만 정리한다.
3. 같은 데이터·질의·시드로 평문, 현재 제품, 후보를 비교한다. SQL 시간, 전체 시간, 후보·반환 행, 인증 복호화 필드를 분리하고 예열 2회·교차 7회 중앙값을 기록한다.
4. 결과는 `bench/results/<YYYY-MM-DD>-<주제>/`에 JSON 원자료와 `report-ko.md`로 둔다. 보고서는 조건·실행 명령·표본/seed·완료 여부·한계·제품 기능으로 일반화할 수 없는 범위를 적는다. 큰 원시 파일은 커밋하지 않는다.
5. `rtk npm run docs:check`로 모든 bench 상대 import와 문서 링크를 검사하고, 작업 범위에 맞는 build/check/test를 실행한다.

## 공개 말뭉치

NSMC `ratings.txt`의 로컬 사본은 `.local/ratings.txt`에만 두며 메모리 공격 시뮬레이션에서만 쓴다. DB 적재는 승인되지 않았다. 기준 SHA-256은 `7d1d8e66323eb5a64feb2e299178f58827d8302111c434195dfeef48506e1256`이다.
