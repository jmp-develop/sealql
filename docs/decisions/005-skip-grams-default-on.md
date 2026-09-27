# 005. 건너뛴 조각 기본 켬

- 상태: 확정 (2026-09-27, 사용자 결정)

## 결정

부분 검색 필드는 건너뛴 조각(i번째와 i+2번째 글자 쌍, gapped q-gram/spaced seed 개념)을 **기본으로 저장**한다. `substring: true`와 `skipGrams`를 적지 않은 객체 옵션은 켬이다. `substring: { skipGrams: false }`만 끈다. 설정을 바꾸면 재색인이 필요하다.

## 근거 (10만 행, 로컬 실측)

| 기준 | 끔 | 켬 | 출처 |
|---|---:|---:|---|
| 모르는 행 80%+ 해독 (5% 원문, 피해 10만 / 2만 행) | 1.19% / 1.70% | **0.03% / 0.56%** | [scale-ko.md](../../bench/results/2026-09-27-layout-attack/scale-ko.md) |
| 조각 간 일관성 공격(`ab·bc → a_c`) 추가 (2만 행, 5%) | — | 0.66% | [layout report](../../bench/results/2026-09-27-layout-attack/report-ko.md) |
| 드문 검색어 `대로6고` 후보 | 170 | **10** | [batching](../../bench/results/2026-09-27-candidate-batching/report-ko.md) |
| `대로6고` SQL 회수 / 전체 ms | 2 / 15.91 | 1 / 5.11 | 같은 폴더 `after/sweep.json` |
| 20행 일반 페이지 전체 ms | 6.6–7.1 | 6.8–7.1 | 같은 폴더 `after/matrix.json` |
| companion 크기 | 211 MB | 305 MB | [storage.json](../../bench/results/2026-09-27-combined-gin/storage.json) |
| 단건 insert 중앙값 | 4.65 ms | 6.16 ms | [skip-write-cost](../../bench/results/2026-09-27-skip-write-cost/report-ko.md) |

- 오탐: 긴 메모 중간 3글자 ×1.38 → ×1.02, 두 단어 ×1.81 → ×1.36, 행당 토큰 약 1.74배 ([corpus-sim3-long.json](../../bench/results/standard-review-2026-09-26/corpus-sim3-long.json)).
- 크기·insert 수치는 필드별 GIN 시절의 측정이다. 현재 다중 컬럼 GIN의 읽기 검증은 [product-multicolumn-gin](../../bench/results/2026-09-27-product-multicolumn-gin/report-ko.md)에 있다.
- 사용자 판단: 암호화는 선택한 필드에만 적용되므로 저장 증가는 문제가 아니다. 보안과 검색 정확도의 이득이 더 크다.
- 일관성 공격은 위치 없는 조각 집합에 대한 투표라 **하한**이다. 더 강한 문자열 전체 복원 공격은 실행하지 않았다.
- 초기 측정(필드별 GIN, 통계 기본)에서는 건너뜀을 켜면 `세종대로` 92 ms, `endsWith` 114 ms로 SQL이 느려졌다. 원인은 계획 선택이었고 256행 prefix([006](006-query-engine.md))로 7.5–8 ms가 됐다. AND 4 약점(62.6 ms)은 다중 컬럼 GIN([007](007-multicolumn-gin-not-combined-array.md))으로 17.9 ms가 됐다.

## 기각안

| 안 | 기각 이유 |
|---|---|
| 기본 끔, 스키마 옵션으로만 제공 | 누출과 드문 검색어 오탐이 더 컸다. 켬의 비용(저장, insert)은 허용 범위 |
| 1글자 검색을 위해 조각 구성 조정 | 1글자 검색은 비목표([009](009-scope-and-non-goals.md)) |

## 대체 관계

- 대체하는 것: "건너뛴 조각은 스키마 옵션, 기본 꺼짐"(원 기록 삭제).
- 관련: [004](004-token-layout-16bit.md), [006](006-query-engine.md), [007](007-multicolumn-gin-not-combined-array.md).
