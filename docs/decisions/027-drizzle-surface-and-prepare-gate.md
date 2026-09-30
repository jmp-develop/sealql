# 027. Drizzle 결속 격리와 전체 검색 준비 관문

- 상태: 확정 (2026-09-30). 계획 002의 F·B를 구현하고 계획을 닫는다. 관련: [026](026-composable-where-and-input-types.md), [019](019-compact-only-search.md).

## 결정

1. **F:** Drizzle 내부 구조 접근(메타 타입, 칼럼 소유 테이블, 트랜잭션 판별, DB 타입, customType 빌더, dialect, table config)을 `src/adapters/drizzle/v0.45/drizzle-surface.ts` 한 곳으로 모은다. 동작은 바꾸지 않는다.
2. **B:** `sealed.prepareAllSearch(db, { batchSize?, signal? })`를 추가한다. 호출 시점에 등록된 모든 모델에 대해 (a) 트랜잭션 안 호출 거부, (b) 읽기 전용 catalog 점검(판정 함수·companion 칼럼·인덱스 valid/ready·제약 validated·통계·저장 설정; DDL은 실행하지 않음, 누락 시 `INVALID_SCHEMA`), (c) 기존 reindex 경로로 전체 재색인과 coverage 증명(시작=끝 행 수, DB 순서 엄격 증가, 중복 0, 방문=시작; 불일치 시 `REBUILD_INCOMPLETE`), (d) 취소 시 `CANCELLED`, (e) 정확한 number 영수증을 반환한다.

## 근거

- F 동작 불변: 공개 `.d.ts` SHA-256 전후 동일, 대표 질의 23개의 SQL·파라미터 직렬화 전후 동일(25,151바이트), 시험·설치 게이트 통과. Drizzle 1.0 RC 컴파일 오류는 surface 파일 안에만 남는다.
- B: reindex는 배치별 커밋이라 중단 시 완료 여부를 알 수 없었고, 새 검색 칼럼이 빈 행은 조용히 검색에서 빠졌다. 0/1/999/1000/1001행, scope 유무, UUID/text, 전부 null, 행 건너뜀 주입, 행 수 변화, 취소·재실행, `extraMigrationSql` 누락, 트랜잭션 거부를 시험했다(`test/standard-prepare-all-search.test.ts`).

## 기각안

| 안 | 이유 |
|---|---|
| 관문이 DDL을 직접 실행 | 앱에 DDL 권한이 필요하고 마이그레이션 도구와 역할이 겹친다. 읽기 전용 점검으로 누락을 막는다 |
| 재작성 값의 JS 재검증기 | 방금 계산·기록한 값의 자기 검증이다. 건너뜀은 coverage, 최신성은 재계산 기록이 보장한다 |
| 영속 완료 표시(DB 상태) | 키·정책 테이블을 두지 않는 원칙([002](002-fixed-keys-no-db-policy.md))과 맞지 않는다. 무중단 전환은 약속하지 않는다 |

## 대체 관계

- 대체하는 것: 없음. 운영 순서(마이그레이션 → `extraMigrationSql` → 관문 → 배포)는 [core-concepts](../core-concepts.md)에 있다.
