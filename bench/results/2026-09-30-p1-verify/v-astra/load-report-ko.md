# P1 독립 검증 준비: 공개 API 적재

최종 제품 빌드 기준: `d943eb49295e5227da17b8c10574170357dddebc`. 지정 스키마 `test_p1_verify`에 원문 100000행을 공개 `sealed.insert`로 적재했다.

| 항목 | 결과 |
|---|---|
| 원본 | 보호 fixture의 *_plain 6칸, 원문 공백·대소문자 유지; 읽기만 |
| 경로 | 공개 패키지 API, 4연결 × 500행 배치 |
| 스키마 | test_p1_verify |
| 설정 | 회사 exact 2비트, 나머지 기본16비트, substring 사용, wordBoundary 없음 |
| 설치 | Drizzle 생성 마이그레이션 + extraMigrationSql + 적재 후 ANALYZE |
| 행 수 | 부모 100000 / 검색 표 100000 단언 통과 |
| 원문 확인 | 첫100행 × 6칸 = 600칸 인증 복호화 원문 일치 |
| 시간 | 적재 진행 시간만 기록; 격리 성능 측정 아님 |
| 인계 | P1 구현 커밋 대기; 후속 3경로 독립 검증을 위해 스키마 유지 |

근거: [load.json](load.json), [schema.json](schema.json), [적재 스크립트](../../../p1-verify/v-astra/load.ts).

일회용 클러스터 검사와 포트 검사를 통과한 뒤 작업했다. 제품 코드 변경 없음. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.
