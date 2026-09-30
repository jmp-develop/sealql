# README 성능 표의 근거 (1.1.0, 2026-09-30)

- 대상: 1.1.0 공개 API, `bench_realistic_100k`에서 파생한 고객 10만 행(합계용 `points`는 행 번호로 결정적 파생), 같은 데이터의 평문 비교 테이블(B-tree + pg_trgm GIN).
- 방법: 일회용 PostgreSQL 18, 예열 2회 뒤 교차 7회 중앙값. 모든 질의의 ID·개수가 평문과 일치(불일치 0).
- 원자료: [result.json](result.json), 측정 스크립트 사본: [run.ts.txt](run.ts.txt).
- 로컬 합성 fixture 결과이며 운영 성능 보장이 아니다. C 로캘 한글 평문 LIKE 배율은 성능 주장에 쓰지 않는다.
