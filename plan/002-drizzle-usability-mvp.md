# 002. Drizzle 사용성 최소 개선과 버전 결속 완화

- 작성일: 2026-09-30. 상태: 제안(검토 4라운드 + 최종 독립 검토 2명 차단 이견 0). 관련: [013](../docs/decisions/013-drizzle-native-api-implemented.md), [019](../docs/decisions/019-compact-only-search.md), [025](../docs/decisions/025-leakage-reevaluation-and-rejected-mitigations.md).
- 불변: `extraMigrationSql`, 설치되는 DB 판정 함수(`stamp-sql.ts`), `exactProof`/`positionProof` 생성 경로, 저장 형식, 검색·count 결과는 **변경 0**.

## 근거 (일회용 DB·격리 설치 실측, 미커밋 조사)

| 사실 | 값 |
|---|---|
| 암호 칼럼에 Drizzle 연산 | `eq`/`ne`/`inArray` → `SEAL_REQUIRED`; `like` 조용히 0행, `orderBy` 암호문 정렬, raw `sql` 비교 0행, `ilike` DB 오류 |
| 공개 훅 차단 가능성 | `customType.toDriver`는 칼럼 인코더로 bind되는 값만 봄 → like/orderBy/raw는 막을 수 없음 |
| DB 타입 차단 | bytea DOMAIN 효과 없음, composite는 정렬·비교 남음·드라이버 오류, 연산자 없는 base type은 superuser 필요·관리형 DB 불가 → 기각 |
| 버전 호환 | 0.45.2·0.45.3 통과, 0.44.7 통과(9/9), 1.0.0-rc.4 컴파일 오류 7건(`PgTransaction`, `PgDatabase`×2, `column.table`×2, `_['columnType']`, customType cast) |
| 부분 재색인 | `reindex`는 1,000행 배치별 커밋·진행점 메모리 → 중단 시 완료 여부 불명, 새 profile 칼럼 null 행은 조용히 검색 누락 |
| 입력 타입 | `PlainShape`는 구현돼 있으나 공개 진입점 미노출, 텍스트 row ID 생략이 타입 통과·실행 실패 |

## 변경

| # | 변경 | 파일 | 합격 조건 |
|---|---|---|---|
| F | Drizzle 저수준 접근을 `drizzle-surface.ts` 한 곳으로 이동(위 7개 지점 포함). peer `>=0.45.2 <0.46` 유지 | `src/adapters/drizzle/v0.45/drizzle-surface.ts`(신규), `native*.ts` | 0.45.2·최신 0.45 build/type/install/DB 통과, 1.0 RC 오류가 surface 밖 0(보고용) |
| C | `InferSealedInsert`(insert·upsert), `InferSealedIdentity`+`InferSealedPatch`(update) 공개. UUID row만 optional, 텍스트 row·scope required | `native.ts`, `native-runtime.ts`, `index.ts` | 설치 tarball 타입 fixture: UUID 생략 통과, 텍스트 row·scope 생략 실패, update patch에 row/scope 불가 |
| B | `sealed.prepareAllSearch(db, { batchSize?, signal? })`: ① 등록 snapshot, 트랜잭션 DB 거부(`INVALID_TRANSACTION_CONTEXT`) ② **읽기 전용** catalog preflight(함수 signature·속성, companion 칼럼, index valid/ready, constraint validated, statistics·storage) — 불일치면 `INVALID_SCHEMA`("migration에 extraMigrationSql 적용 필요"), DDL 실행 안 함 ③ 전 parent 재색인 + coverage(시작=끝 count, DB 순서 엄격 증가, 중복 0, 방문=시작, bigint→safe number) 불일치면 `REBUILD_INCOMPLETE` ④ abort checkpoint(`CANCELLED`) ⑤ 정확한 number receipt | `native-runtime.ts`, `native.ts`, 오류 코드 | 0/1/999/1000/1001행, scope 유무, UUID/text, all-null, 중간 행 건너뜀 주입·중복·count 변화·취소·재실행이 모두 판정됨 |
| A·E | 코드 변경 없음. `eq`/`ne`/`inArray` 차단 회귀 시험, 미지원 연산(like/orderBy/raw)과 JOIN 콜백 책임을 문서화(구체 DB 결과는 계약으로 고정하지 않음) | `test/`, `docs/adapters/drizzle-v0.45.md` | 문서·시험 통과 |

운영 계약: 옛 앱 트래픽을 멈추고 → drizzle-kit migration(+`extraMigrationSql`) → `prepareAllSearch` 성공 → 새 앱 배포. 무중단 전환은 약속하지 않는다.

## 나중 (이번 범위 밖)

| 항목 | 이유 |
|---|---|
| JS 저장 도장 검증기 | 방금 계산·기록한 값의 자기 재검증. 건너뜀은 coverage, 최신성은 재계산 upsert가 보장 |
| 선택 `returning` | 편의 기능 |
| lint, raw/JOIN helper, JOIN 검증 표시 | 표시는 누락을 증명 못 하고 volatile SQL 재평가 문제 |
| Drizzle 0.44·1.0 지원 | 전체 소비자 행렬 필요, 1.0은 별도 어댑터 |

## 검증

`build`, `check`, `test`, `docs:check`, `test:install`(0.45.2·최신 0.45), node-pg·postgres-js DB 흐름. DB 시험은 `assertDisposable`+포트 56439, 전용 스키마. 기존 판정 함수·생성 경로 diff 0 확인. 완료 후 결정 기록으로 요약하고 이 파일을 지운다.
