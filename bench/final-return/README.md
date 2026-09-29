# 연구 최종안 / compact-only 제품 비교

결과와 판정은 [한국어 보고서](../results/2026-09-29-final-return/report-ko.md)에 둔다. 제품 소스는 `527d13f`, SQL 변형은 `variants.ts`의 별도 커밋이다. 제품 API는 패키지 공개 dist export를 사용한다. SQL 변형의 메타데이터는 같은 설정의 src 모델을 만들고 실제 dist 열 이름과 일치를 확인한다.

모든 DB 진입점은 `common.ts`에서 `assertDisposable`과 포트를 확인한다. 허용 DB는 일회용 56439뿐이다. `bench_realistic_100k`, `native_*`는 읽기만 한다. 시간 측정은 `measure.lock`을 독점한다. 원본 적재 시간은 성능 수치가 아니다.

적재 완료 후 최종 일괄 실행은 `rtk proxy node bench/final-return/run-final.mjs 59d4ce9`이다. 빌드 전부터 조회·쓰기·용량·보고까지 같은 소유자의 락을 유지한다. 제품 소스·패키지·빌드 설정이 지정 커밋과 같은지 검증하므로 후속 벤치·문서 전용 커밋은 허용한다. 조회 25/50/75/100%에서 코디네이터 status를 보낸다.

마감 보완 실행은 `rtk proxy node bench/final-return/run-remeasure.mjs <보완 커밋>`이다. 락 인계 후 git archive의 지정 커밋을 별도 로컬 디렉터리에서 빌드하므로 다른 작업자의 후속 src/dist 변경과 섞이지 않는다. DB guard는 원래 작업 디렉터리의 `test/disposable.ts`를 그대로 호출한다. count55개와 LIKE 목록300 3개만 같은 3경로로 재측정하고, `remeasure.json`에 저장해 기존 보고서의 추가 절로 붙인다. 2026-09-29 08:48Z에 다음 호출 시작을 중단하며 완료된 조회만 중앙값으로 보고한다. 진행 중 조회의 미완료 반복은 별도로 보존하고 완료된7회 자료와 섞지 않는다. 이전113개·쓰기·용량 결과를 덮어쓰지 않는다.

| 순서 | 실행 (`rtk proxy node --import tsx` 뒤) | 역할 |
|---|---|---|
| 1 | `bench/final-return/freeze-research.ts` | 역사적 함수와 열 이름 고정 |
| 2 | `bench/final-return/load-baseline.ts` | `research_u` 평문·pb_4_final 새로 적재; 기존 표가 있으면 중단 |
| 3 | `bench/final-return/check-baseline.ts` | 원문 정규화 oracle로 52조건 확인 |
| 4 | `bench/final-return/load-product.ts --commit 527d13f` | 새 제품 스키마 공개 API 원문 적재; 적재할 빌드 HEAD 검증 |
| 5 | `bench/final-return/measure.ts --commit <최종 커밋>` | 최종 제품 함수 재설치·ANALYZE, 변형 없는 3경로 113조회, 이후 EXPLAIN |
| 6 | `bench/final-return/capacity.ts` | heap·TOAST·색인 크기 |
| 7 | `bench/final-return/writes.ts` | 별도 쓰기 스키마에서 행별 트랜잭션 비교 |
| 8 | `bench/final-return/report.mjs` | JSON으로 한국어 보고서와 완료 시 artifact-check 생성 |

조회는 같은 물리 연결에서 첫 실행, 예열 2회, 교차 7회를 수행하며 매번 count/정렬 ID/투영 값과 인증 복호화 횟수를 단언한다. 변형 준비는 SQL 구간 밖이며 원래 공개 API 준비 비용은 전체 시간에 남는다. 드라이버 인터셉터는 `query(config, values)`의 별도 values와 rowMode를 보존한다. 회귀 확인은 `rtk proxy node --import tsx --test bench/final-return/instrument.test.ts`이다.

코디네이터 요청으로 변형 전체 행렬은 60개에서 중단했다. `measure-variants.ts`는 당시 실행 보존용이며 다시 실행하지 않는다. 부분 결과는 `measure-variants-partial.json`과 `report-variants-partial-ko.md`에 보존한다. 이후 최종 실행은 `measure.ts`의 세 경로뿐이다. 쓰기·용량 스크립트는 최종 조회 완료를 확인한 뒤 실행한다. 최종 실행 중 중단 요청은 `final-return-stop` 파일 또는 SIGINT/SIGTERM으로 받고, 현재 조건의 count·목록을 마친 뒤 부분 결과 저장과 락 해제를 수행한다.

4c는 MAIN/EXTENDED × 꼬리 색인 유무의 네 새 복제본에 동일한 도장·후보 값을 ID순으로 삽입한다. 배열 연결로 기존 TOAST 값을 재물질화하여 저장 방식 변경을 실제 데이터에 적용한다. 네 복제본끼리 두 요인을 비교한다. 원래 제품은 병렬 배치로 적재했으므로 원본과 복제본 비교에는 물리 순서 효과가 포함된다. 복제본 전체 열 일치 검증을 수행한다. 완료된 setup만 재사용하며 함수는 프로세스마다 다시 설치한다.

연구 목록의 암호 본문과 후보 토큰은 역사적 native 표를 읽고, 위치 도장은 같은 원문에서 새로 만든다. 쓰기에서는 역사적 정규화 암호문을 유지한다. 새 제품 쓰기는 원문을 보존하며 원문 왕복도 확인한다. LIKE 3조건은 역사적 affix/contains와 정확히 동치인 패턴으로 한정한다. 보안 시험이나 일반 LIKE 지원의 증거로 확대하지 않는다.

실패한 조회 결과는 재시작 시 `measure-prior-*`로 보존한다. 부분 적재를 자동 삭제하지 않는다. 완료 보고 전 다른 프로세스의 락을 지우거나 보호 표를 변경하지 않는다. 커밋은 수행하지 않는다.
