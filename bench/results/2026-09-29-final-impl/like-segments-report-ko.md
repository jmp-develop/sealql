# 일반 LIKE 구간 판정 전후 검증

동일 연결 PID 39732에서 예열 2회·교차 7회 중앙값이다. 보호 표와 원래 함수는 읽기만 하고 새 임시 스키마에 후보 함수를 설치했다.

| 패턴 | 방식 | 이전 SQL ms | 구간 판정 SQL ms | 이전 전체 ms | 구간 판정 전체 ms |
|---|---|---:|---:|---:|---:|
| %est | count | 351.43 | 352.43 | 352.60 | 353.44 |
| %est | list300 | 6.67 | 6.58 | 67.39 | 66.40 |
| %te%st | count | 1584.80 | 654.89 | 1586.42 | 656.00 |
| %te%st | list300 | 18.19 | 9.64 | 79.66 | 75.26 |
| %te__ | count | 1196.11 | 424.79 | 1197.21 | 425.95 |
| %te__ | list300 | 13.79 | 7.19 | 76.79 | 70.24 |

각 패턴은 이메일 10만 건에 모두 일치했다. count 및 ID순 목록300의 전체 정규화 투영이 평문과 같았다. 이전 경로에도 커밋 6fc43de의 단일 literal 정규화가 포함되므로 %est 비교는 함수 공통화의 회귀 확인이다.

겹치는 구간·이스케이프·_/% 조합·유니코드·반복·4002자·빈 값·NULL은 test/like-segments.test.ts에서 PostgreSQL LIKE와 3836건 대조했다. 입력은 질의 인자이며 새 레코드를 적재하지 않았다.

원시 반복값·EXPLAIN·버퍼·함수 SQL 호출은 [원시 결과](like-segments-check.json)에 있다. 락 인계로 중단한 첫 실행은 like-segments-check-interrupted.json에 남겼으며 채택 근거에서 제외했다. 모든 일반 LIKE 패턴의 성능은 검증하지 않았다.

로컬 fixture 실험이며 운영 성능 보장이나 보안 인증이 아니다.

검증 대상 구현은 `3c98287`이다. `rtk proxy node --import tsx bench/final-return/like-segments-check.ts`는 완료했고, `npm run build`, `npm run check`, `npm test`, `npm run docs:check`, `npm run test:install`은 모두 exit 0이다. 실제 전체 테스트 출력은 `tests 39 / pass 39 / fail 0 / duration_ms 115314.446`이며 Node pg·postgres-js·local workerd pg의 공개 흐름은 모두 `ok:true`다. 설치 시험은 Drizzle 0.45.3·0.45.2에서 통과했고 기존 upstream 선언 진단 70건씩을 제외했다. 원 출력은 같은 폴더의 `gate-like-segments-*.log`에 보존한다.

미검증 범위는 모든 일반 LIKE 패턴의 성능, 이 변경 이후 독립 검증자의 최종 재측정이다. 보호 표와 원래 함수는 바꾸지 않았으므로 설치 시 `extraMigrationSql`을 재적용한다. compact-only 데이터의 재색인은 필요 없다. 측정 락은 해제했다.
