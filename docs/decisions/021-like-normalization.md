# 021 — LIKE를 같은 의미의 위치 조건으로 정규화

2026-09-29. 일반 LIKE 후속 개선은 [022](022-like-segment-order.md)에 기록한다.

## 결정

LIKE의 literal 구간이 하나이고 와일드카드가 양 끝의 `%`뿐이면 contains·startsWith·endsWith와 같은 후보 토큰과 위치 도장 판정으로 컴파일한다. 연속 `%`와 이스케이프는 기존 공통 파서가 처리한다. 와일드카드 없는 LIKE는 compact 문자열 전체 일치이므로 시작 위치와 정규화 길이를 함께 검사한다. exact 프로필이 없어도 동작하며 공백 보존 exact normalizer의 의미를 섞지 않는다. 최소 literal 길이 2글자 규칙은 유지한다.

여러 literal 구간이나 `_`가 있는 패턴은 일반 LIKE 판정에 남는다. 이 결정만으로 일반 LIKE의 성능 문제를 해결했다고 주장하지 않는다. 저장된 암호문·토큰·도장과 공개 API는 변하지 않으며 이 변경만을 위한 재색인은 없다.

## 근거

[같은 세션 측정](../../bench/results/2026-09-29-final-impl/next-candidates-check.json)에서 이메일 `%est` 10만 건 count는 정규화 후 SQL 왕복 377.51ms, 목록300은 6.45ms였다. 독립 최종 측정의 이전 제품 count 1,233ms는 다른 세션이므로 엄밀한 같은 세션 배율은 아니다. 두 측정 모두 같은 fixture에서 평문과 일치했다. 일반 LIKE `%te%st`와 `%te__`는 각각 1,578.55ms와 1,179.03ms로 추가 개선이 필요하다.

## 기각안

첫 등장 충분조건 A는 흔한 세 조건의 count를 줄였지만 반복 값 80.28→118.83ms, 45자 17.56→133.71ms로 퇴행하여 연기한다. 23창 단일 판정 SQL은 약9.6KB이며 행별 SubPlan과 실패 후 중복 판정 비용이 남는다. SQL의 NULL 길이 입력에서도 불필요한 선행 탐색이 나타났다. 창 수별 특례는 추가하지 않는다.

TOAST 목표값 B는 [독립 용량 검증](../../bench/results/2026-09-29-final-return/capacity.json)에서 제품 검색 표 TOAST heap이 0MiB로 확인되어 불필요하다. 후보 기본값·저장 파라미터를 제품에 추가하지 않았고 복제·VACUUM FULL 실험도 실행하지 않았다.

## 대체 관계

017의 모든 LIKE에 대한 위치 목록 선행 계산을 단일 literal 패턴에 한해 대체한다. 019의 compact-only 형식과 020의 후보·판정·LIMIT, 전진 커서, COST, MAIN은 유지한다. 로컬 fixture 결과이며 운영 성능 보장이나 보안 인증이 아니다.
