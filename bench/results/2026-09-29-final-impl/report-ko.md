# compact-only 제품 변경·후보 검증

## 범위

기준은 연구 최종안이다. singleton·words 스트림과 단어 경계 토큰/옵션을 제거하며 저장·질의·쓰기·reindex·공개 문서를 함께 변경한다. 4a–4d 성능 후보는 독립 측정자의 기준선 적재 종료 후 측정 락을 잡은 비교로 판단한다. 적재와 병행한 아래 정확성 게이트 시간은 성능 수치가 아니다.

## 단계 1 — compact2만 저장

substring 저장은 후보 token 배열과 compact2 salt·length·stamp·offset 배열뿐이다. 모든 LIKE literal 구간이 정규화 후2글자 이상이어야 하며 singleton이 있는 패턴은 `QUERY_TOO_BROAD`다. `%`·`_`·이스케이프와 empty/1글자 exact는 유지한다. words 길이 차이·singleton 키 채널은 제거하지만 기존 token·길이·관찰 조각 위치 누출은 남는다.

관리형 쓰기와 전체 reindex, NULL 묶음 검사, cascade 삭제, 행·필드·scope 인증 결속을 유지한다. token descriptor에서 제거한 경계 설정 때문에 스키마 갱신·추가 함수 설치·전체 reindex를 마친 뒤 새 제품을 사용해야 한다. 보호 스키마는 읽기만 한다.

## 게이트

제품 단계1은 `527d13f`다. 원본 로그는 이 폴더에 저장한다. 첫 테스트에서 compact 전화번호의 부분 문자열이3개 행과 일치했지만 제거 전 단어 경계의 예상1개를 그대로 둔 단언이 실패했다([첫 로그](gate-test-initial.log)). 예상값을 독립 정규화 평문 oracle로 교체했다.

| 명령 | 실제 결과 |
|---|---|
| `rtk proxy npm run build` | exit0 ([로그](gate-build.log)) |
| `rtk proxy npm run check` | exit0 ([로그](gate-check.log)) |
| `rtk proxy npm test` | tests37, pass37, fail0, duration_ms119091.3224 ([로그](gate-test.log)) |
| `rtk proxy npm run docs:check` | Documentation entry, links, decisions, plans, exports, and shared example references PASS ([로그](gate-docs-check.log)) |
| `rtk proxy npm run test:install` | Drizzle0.45.3/0.45.2 consumer compiles, exit0 ([로그](gate-test-install.log)) |

Node pg·postgres-js·local workerd pg 모두 insert/count/update/reindex/search/substring=1, afterDelete=0, ok=true를 출력했다. 단어 경계 전용 양성 테스트1개를 제거해 전체 테스트 수는38→37이다. 제거 옵션의 오류와 LIKE singleton 거절, 저장 열 부재, 201/501행 및 OR/keyset 평문 대조는 남아 있다. 설치 스크립트는 기존대로 upstream 선언 진단70개를 제외한다.

## 기계적 누출 시험

`rtk proxy node --import tsx bench/r9/compact-only-audit.ts` exit0. fixture250행·메모리 전용 공개 리뷰250행에서 compact 위치 도장3408/6951개를 검사했고 중복·순열 오류·관찰 키 위치 복원 오류는0이었다. 관찰 키로250/283개 위치를 복원했다. 스키마에 singleton/words 열이 없고, 공백 추가가 compact 길이·후보 토큰을 바꾸지 않음을 단언했다([원본](compact-audit.json)). 암호문 바이트 길이는 달라질 수 있으며 공백 정보를 전부 숨긴다는 주장이 아니다. 기존 사전·동시출현·WAL 공격은 재실행하지 않았다.

## 4a–4d 변형의 정확성

[벤치 변형](../../final-return/variants.ts)과 [사용법](../../final-return/variants-usage.md)은 제품 옵션을 만들지 않는다. `rtk proxy node --import tsx --test bench/final-return/variants.test.ts`는 tests1/pass1/fail0, duration_ms1249.4318이었다. 기존 fixture에서 파생한 두 scope·같은 row ID, NULL, rollback, 동시 부분 수정, 삭제 cascade와 reindex 뒤 직접 companion count를 평문/제품과 대조했다. 작은 probe로 fallback을 강제로 실행해 최상위 OR와 중첩 AND/OR의 전체 keyset 목록을 대조했고, 검사 제거 및 pg_catalog 한정/no-SET 함수에서도 일치했다. 이는 정확성 확인이며 성능 채택 판단은 아니다.

## 아직 검증하지 않은 범위

4a–4d 전후 성능, 연구 최종안 대비52조건 기준, 새로운 쓰기·용량 수치는 독립 비교 측정 후 기록한다. 로컬 fixture 검증은 운영 성능 보장이나 보안 인증이 아니다.
