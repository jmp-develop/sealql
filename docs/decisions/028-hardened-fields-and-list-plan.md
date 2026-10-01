# 028 — 칸별 hardened와 토큰 없는 목록 경로

2026-10-02. `standard`의 salt 도장 판정은 유지하고 칸별 후보 토큰 생성을 선택한다. 기본 프로필의 저장·질의 SQL·파라미터와 공개 질의·반환 계약은 유지한다.

`hardened: true`는 검색 가능한 칸에 설정하며 결정적 후보 토큰·그 칼럼·색인을 만들지 않는다. text는 기존 정확·부분·LIKE, integer/bigint/decimal은 정확 일치를 사용한다. 검색 없는 칸과 지원하지 않는 타입은 `INVALID_SCHEMA`다. 기존 제네릭의 허용 범위와 오류 메시지를 강화할 수 있는 추가 공개 타입 제한은 보류했다. 공개 `searchTokens`에 hardened 프로필을 전달하면 `UNSUPPORTED_SEARCH`다. 토큰 키를 유도하지 않는 hardened 표시는 descriptor에 넣지 않는다. 켜고 끌 때 migration → extraMigrationSql → prepareAllSearch로 칼럼 집합·자료·전체 행 coverage를 확인한다.

저장 토큰 결정성만 제거한다. 길이·compact 위치 순열과 관찰된 값/조각 키는 남으므로 파라미터 로그 금지는 그대로다. 기존 칸의 전환은 companion 재작성 또는 재생성·재구축으로 현재 테이블의 옛 칼럼을 정리한다. 전환 전 백업·WAL의 옛 토큰은 사라지지 않는다. 토큰 없는 보장을 그 사본까지 적용하려면 폐기하고, 유지하는 사본은 기존 프로필의 보호 기준을 적용한다. 재작성은 옛 디스크 페이지나 사본의 안전한 삭제를 보장하지 않는다.

유한 ID순 목록의 술어에 토큰 조건이 하나도 없으면 companion에서 scope·keyset·proof를 적용하고 row_id로 정렬해 LIMIT을 거는 한 경로를 쓴다. 모든 leaf가 hardened인 AND/OR에 적용하고 일반·혼합 토큰 조건은 [020](020-companion-predicate-plans.md)의 SQL을 그대로 사용한다. 관리형 쓰기·부분 수정·삭제·scope·NULL·커서 계약은 바꾸지 않는다. SQL 경로만 바뀌므로 이 최적화 자체에는 migration·extraMigrationSql·reindex가 필요 없다.

앞부분과 fallback은 원래 서로 다른 행을 판정했다. 중복 전체 재판정이 병목은 아니었다. 작은 직접 스캔은 prefix materialization·중간 결과 전달을 없애지만 희귀·0건에서 ID순 heap 방문이 남아 count보다 느릴 수 있다. 남은 행을 먼저 전부 판정하고 일치 ID만 정렬하는 대안은 0건·LIKE를 크게 줄였지만 중간 빈도 목록을 약 8→214 ms로 퇴행시켜 기각했다. 후보 토큰 없이 전체 값 빈도를 미리 알 근거가 없어 두 전략을 자동 선택하거나 새로운 기준을 도입하지 않는다.

성능·공격의 원자료와 채택/기각안은 [통합 보고](../../bench/results/2026-10-02-hardened/report-ko.md)에 있다. 메모리 공격의 낮은 복원율은 안전의 증거가 아니며, 알려진 검색어 관찰은 전화·주소·회사 100%로 일반 부분 검색과 같았다. 큰 범위에서는 다른 인덱스 조건과 함께 사용한다. 로컬 합성 fixture의 결과이며 운영 보장·보안 인증이 아니다.
