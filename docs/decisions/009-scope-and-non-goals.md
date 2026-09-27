# 009. 범위와 비목표

- 상태: 확정 (2026-09-27, 사용자 결정)

## 결정

지원하는 것:

- 암호화 텍스트·숫자 필드의 정확 일치, 2글자 이상 부분 검색(`contains`, `startsWith`, `endsWith`, `like`, 단어 경계 옵션), AND/OR 조합, 커서 페이지, 정확한 count, JOIN 결과의 인증 복호화.
- PostgreSQL. Drizzle ORM 0.45(선택적 peer)와 raw SQL. Node 22 이상과 Cloudflare Workers.

지원하지 않는 것(비목표):

| 비목표 | 이유와 대안 |
|---|---|
| 암호화 필드의 DB 집계(SUM, AVG, GROUP BY, 암호 부분 검색 조건 아래의 정확 통계) | DB에 키가 없다. 앱에서 후보 전체를 복호화하면 계산은 되지만 비용이 후보 수에 비례해 제품 기능으로 두지 않는다. **정확한 DB 계산이 필요한 필드는 암호화하지 않는다** |
| 암호화 필드의 범위 검색·정렬 | ORE/OPE는 순서가 샌다([001](001-search-hmac-pieces-gin-verify.md)). 평문 컬럼으로 정렬하거나 받은 결과 안에서 정렬한다. 범위는 나중에 구간 토큰으로 검토할 수 있다 |
| 1글자 검색 | 조각을 만들 수 없다. 최소 2글자 |
| `not` 조건 | 토큰 색인으로 후보를 좁힐 수 없어 scope 전체를 복호화해야 한다. 공개 API에 두지 않는다 |
| 여러 키 설정에 걸친 검색 | [002](002-fixed-keys-no-db-policy.md) |
| 오프셋 페이지네이션, 근사 count | [006](006-query-engine.md) |
| 키 교체·키 버전 | 고정 키. 바꾸려면 앱이 전체 재암호화·재색인 |

## 현재 한계 (해결 예정)

- **일반 칸과 암호 칸 사이의 OR**(예: `상태 = '완료' OR 이름에 '김' 포함`)을 `findMany`로 표현할 수 없다. `match`와 `where`는 AND로 결합되고, 일반 SQL 조각을 OR에 넣으면 `INVALID_VALUE`로 거부된다 ([V1 재현](../../bench/results/2026-09-27-core-verification/v1/report-ko.md)). [plan/001](../../plan/001-drizzle-native-api.md)의 `m.sql(cond)`로 해결할 예정이다.
- `searchWithQuery`(JOIN·사용자 SQL)는 옛 설계(queryId, parameters)를 물려받아 번거롭다. plan/001의 `search`로 대체한다.

## 대체 관계

- 관련: [001](001-search-hmac-pieces-gin-verify.md), [002](002-fixed-keys-no-db-policy.md), [006](006-query-engine.md), [008](008-drizzle-integration.md).
