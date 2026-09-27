# 제품 토큰 입력 구조의 조각 비트 비교

2026-09-27 · 로컬 `.local/ratings.txt` 메모리 측정, DB 적재 없음. 피해 2만/10만 행은 같은 공개 리뷰의 접두 구간이고, 10만 행 뒤의 별도 2만 행은 참고 구간으로 예약했다. 이 원문 대조·오탐 측정은 참고 원문을 사용하지 않는다. 알려진 행은 규모별 시드 99 Fisher–Yates 순서의 중첩된 1%/5%다.

벤치 전용 토큰 함수는 제품의 HKDF(SHA-384) 정보 프레임, HMAC(SHA-384) 값·scope 프레임, 32비트 scope 접두와 부호 있는 64비트 packing을 그대로 사용했다. 프로필 설명자는 제품의 16비트 프로필로 고정하고 HMAC 값의 상위 절단 비트만 14/15/16/17/20으로 바꿨다. 제품은 부분 검색에 16비트만 허용하므로 다른 비트는 제품 기능이 아니다. 16비트 결과는 두 구성의 서로 다른 조각 142,548개·148,140개 전부를 제품 `searchTokens`와 비교해 불일치 0건이었다.

## 알려진 원문 공격

조각 등장 기준 인접 조각 해독률과, 알려지지 않은 피해 행 중 저장된 전체 조각의 80% 이상을 해독한 비율이다. 공격은 알려진 행의 토큰·조각 행집합이 같고 후보 조각이 하나일 때만 매핑한다.

| 구성 | 피해 행 | 값 비트 | 알려진 원문 | 인접 해독 | 모르는 행 80%+ |
|---|---:|---:|---:|---:|---:|
| adjacent | 20,000 | 14 | 1% | 22.91% | 0.65% |
| adjacent | 20,000 | 14 | 5% | 26.35% | 0.58% |
| adjacent | 100,000 | 14 | 1% | 29.41% | 0.79% |
| adjacent | 100,000 | 14 | 5% | 11.55% | 0.16% |
| adjacent | 20,000 | 15 | 1% | 27.02% | 1.26% |
| adjacent | 20,000 | 15 | 5% | 40.65% | 2.98% |
| adjacent | 100,000 | 15 | 1% | 41.60% | 3.30% |
| adjacent | 100,000 | 15 | 5% | 29.94% | 0.50% |
| adjacent | 20,000 | 16 | 1% | 28.74% | 2.02% |
| adjacent | 20,000 | 16 | 5% | 47.72% | 6.26% |
| adjacent | 100,000 | 16 | 1% | 47.73% | 6.70% |
| adjacent | 100,000 | 16 | 5% | 48.04% | 3.64% |
| adjacent | 20,000 | 17 | 1% | 29.15% | 2.11% |
| adjacent | 20,000 | 17 | 5% | 51.09% | 8.35% |
| adjacent | 100,000 | 17 | 1% | 51.29% | 8.86% |
| adjacent | 100,000 | 17 | 5% | 61.25% | 11.53% |
| adjacent | 20,000 | 20 | 1% | 29.97% | 2.42% |
| adjacent | 20,000 | 20 | 5% | 56.23% | 13.44% |
| adjacent | 100,000 | 20 | 1% | 54.93% | 12.31% |
| adjacent | 100,000 | 20 | 5% | 74.99% | 43.06% |
| adjacent+start/end+word | 20,000 | 14 | 1% | 23.56% | 0.35% |
| adjacent+start/end+word | 20,000 | 14 | 5% | 24.40% | 0.02% |
| adjacent+start/end+word | 100,000 | 14 | 1% | 24.80% | 0.12% |
| adjacent+start/end+word | 100,000 | 14 | 5% | 8.89% | 0.00% |
| adjacent+start/end+word | 20,000 | 15 | 1% | 26.35% | 1.51% |
| adjacent+start/end+word | 20,000 | 15 | 5% | 35.82% | 0.29% |
| adjacent+start/end+word | 100,000 | 15 | 1% | 37.23% | 0.93% |
| adjacent+start/end+word | 100,000 | 15 | 5% | 26.85% | 0.04% |
| adjacent+start/end+word | 20,000 | 16 | 1% | 27.77% | 2.18% |
| adjacent+start/end+word | 20,000 | 16 | 5% | 44.65% | 1.70% |
| adjacent+start/end+word | 100,000 | 16 | 1% | 45.24% | 5.18% |
| adjacent+start/end+word | 100,000 | 16 | 5% | 46.22% | 1.19% |
| adjacent+start/end+word | 20,000 | 17 | 1% | 28.46% | 2.53% |
| adjacent+start/end+word | 20,000 | 17 | 5% | 48.70% | 5.44% |
| adjacent+start/end+word | 100,000 | 17 | 1% | 49.50% | 9.49% |
| adjacent+start/end+word | 100,000 | 17 | 5% | 58.66% | 7.06% |
| adjacent+start/end+word | 20,000 | 20 | 1% | 29.43% | 3.81% |
| adjacent+start/end+word | 20,000 | 20 | 5% | 55.64% | 25.39% |
| adjacent+start/end+word | 100,000 | 20 | 1% | 54.64% | 24.53% |
| adjacent+start/end+word | 100,000 | 20 | 5% | 75.40% | 70.09% |

## 검색 오탐

제품 `searchPieces`의 네 검색어를 같은 행에 적용한 메모리 후보 수다. 정답은 원문에서 확인했고, 두 단어는 공백을 보존하며 시작 자동완성은 필드 시작에서 확인했다. 배율은 후보/정답이며 DB 속도는 측정하지 않았다.

| 구성 | 피해 행 | 값 비트 | 검색 | 정답 | 후보 | 오탐 배율 |
|---|---:|---:|---|---:|---:|---:|
| adjacent | 20,000 | 14 | 2-char contains (영화) | 6355 | 6409 | 1.008 |
| adjacent | 20,000 | 14 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent | 20,000 | 14 | two-word contains (정말 재미) | 85 | 102 | 1.200 |
| adjacent | 20,000 | 14 | field-start autocomplete (정말) | 489 | 1617 | 3.307 |
| adjacent | 100,000 | 14 | 2-char contains (영화) | 32015 | 32270 | 1.008 |
| adjacent | 100,000 | 14 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent | 100,000 | 14 | two-word contains (정말 재미) | 510 | 605 | 1.186 |
| adjacent | 100,000 | 14 | field-start autocomplete (정말) | 2562 | 8295 | 3.238 |
| adjacent | 20,000 | 15 | 2-char contains (영화) | 6355 | 6379 | 1.004 |
| adjacent | 20,000 | 15 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent | 20,000 | 15 | two-word contains (정말 재미) | 85 | 101 | 1.188 |
| adjacent | 20,000 | 15 | field-start autocomplete (정말) | 489 | 1617 | 3.307 |
| adjacent | 100,000 | 15 | 2-char contains (영화) | 32015 | 32094 | 1.002 |
| adjacent | 100,000 | 15 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent | 100,000 | 15 | two-word contains (정말 재미) | 510 | 600 | 1.176 |
| adjacent | 100,000 | 15 | field-start autocomplete (정말) | 2562 | 8292 | 3.237 |
| adjacent | 20,000 | 16 | 2-char contains (영화) | 6355 | 6356 | 1.000 |
| adjacent | 20,000 | 16 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent | 20,000 | 16 | two-word contains (정말 재미) | 85 | 100 | 1.176 |
| adjacent | 20,000 | 16 | field-start autocomplete (정말) | 489 | 1610 | 3.292 |
| adjacent | 100,000 | 16 | 2-char contains (영화) | 32015 | 32023 | 1.000 |
| adjacent | 100,000 | 16 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent | 100,000 | 16 | two-word contains (정말 재미) | 510 | 597 | 1.171 |
| adjacent | 100,000 | 16 | field-start autocomplete (정말) | 2562 | 8273 | 3.229 |
| adjacent | 20,000 | 17 | 2-char contains (영화) | 6355 | 6356 | 1.000 |
| adjacent | 20,000 | 17 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent | 20,000 | 17 | two-word contains (정말 재미) | 85 | 100 | 1.176 |
| adjacent | 20,000 | 17 | field-start autocomplete (정말) | 489 | 1610 | 3.292 |
| adjacent | 100,000 | 17 | 2-char contains (영화) | 32015 | 32023 | 1.000 |
| adjacent | 100,000 | 17 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent | 100,000 | 17 | two-word contains (정말 재미) | 510 | 597 | 1.171 |
| adjacent | 100,000 | 17 | field-start autocomplete (정말) | 2562 | 8273 | 3.229 |
| adjacent | 20,000 | 20 | 2-char contains (영화) | 6355 | 6355 | 1.000 |
| adjacent | 20,000 | 20 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent | 20,000 | 20 | two-word contains (정말 재미) | 85 | 100 | 1.176 |
| adjacent | 20,000 | 20 | field-start autocomplete (정말) | 489 | 1575 | 3.221 |
| adjacent | 100,000 | 20 | 2-char contains (영화) | 32015 | 32015 | 1.000 |
| adjacent | 100,000 | 20 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent | 100,000 | 20 | two-word contains (정말 재미) | 510 | 596 | 1.169 |
| adjacent | 100,000 | 20 | field-start autocomplete (정말) | 2562 | 8095 | 3.160 |
| adjacent+start/end+word | 20,000 | 14 | 2-char contains (영화) | 6355 | 6374 | 1.003 |
| adjacent+start/end+word | 20,000 | 14 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent+start/end+word | 20,000 | 14 | two-word contains (정말 재미) | 85 | 87 | 1.024 |
| adjacent+start/end+word | 20,000 | 14 | field-start autocomplete (정말) | 489 | 494 | 1.010 |
| adjacent+start/end+word | 100,000 | 14 | 2-char contains (영화) | 32015 | 32129 | 1.004 |
| adjacent+start/end+word | 100,000 | 14 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent+start/end+word | 100,000 | 14 | two-word contains (정말 재미) | 510 | 526 | 1.031 |
| adjacent+start/end+word | 100,000 | 14 | field-start autocomplete (정말) | 2562 | 2585 | 1.009 |
| adjacent+start/end+word | 20,000 | 15 | 2-char contains (영화) | 6355 | 6373 | 1.003 |
| adjacent+start/end+word | 20,000 | 15 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent+start/end+word | 20,000 | 15 | two-word contains (정말 재미) | 85 | 87 | 1.024 |
| adjacent+start/end+word | 20,000 | 15 | field-start autocomplete (정말) | 489 | 494 | 1.010 |
| adjacent+start/end+word | 100,000 | 15 | 2-char contains (영화) | 32015 | 32123 | 1.003 |
| adjacent+start/end+word | 100,000 | 15 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent+start/end+word | 100,000 | 15 | two-word contains (정말 재미) | 510 | 526 | 1.031 |
| adjacent+start/end+word | 100,000 | 15 | field-start autocomplete (정말) | 2562 | 2580 | 1.007 |
| adjacent+start/end+word | 20,000 | 16 | 2-char contains (영화) | 6355 | 6355 | 1.000 |
| adjacent+start/end+word | 20,000 | 16 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent+start/end+word | 20,000 | 16 | two-word contains (정말 재미) | 85 | 87 | 1.024 |
| adjacent+start/end+word | 20,000 | 16 | field-start autocomplete (정말) | 489 | 494 | 1.010 |
| adjacent+start/end+word | 100,000 | 16 | 2-char contains (영화) | 32015 | 32016 | 1.000 |
| adjacent+start/end+word | 100,000 | 16 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent+start/end+word | 100,000 | 16 | two-word contains (정말 재미) | 510 | 526 | 1.031 |
| adjacent+start/end+word | 100,000 | 16 | field-start autocomplete (정말) | 2562 | 2578 | 1.006 |
| adjacent+start/end+word | 20,000 | 17 | 2-char contains (영화) | 6355 | 6355 | 1.000 |
| adjacent+start/end+word | 20,000 | 17 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent+start/end+word | 20,000 | 17 | two-word contains (정말 재미) | 85 | 87 | 1.024 |
| adjacent+start/end+word | 20,000 | 17 | field-start autocomplete (정말) | 489 | 494 | 1.010 |
| adjacent+start/end+word | 100,000 | 17 | 2-char contains (영화) | 32015 | 32015 | 1.000 |
| adjacent+start/end+word | 100,000 | 17 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent+start/end+word | 100,000 | 17 | two-word contains (정말 재미) | 510 | 526 | 1.031 |
| adjacent+start/end+word | 100,000 | 17 | field-start autocomplete (정말) | 2562 | 2578 | 1.006 |
| adjacent+start/end+word | 20,000 | 20 | 2-char contains (영화) | 6355 | 6355 | 1.000 |
| adjacent+start/end+word | 20,000 | 20 | middle 3-char contains (서비스) | 3 | 3 | 1.000 |
| adjacent+start/end+word | 20,000 | 20 | two-word contains (정말 재미) | 85 | 87 | 1.024 |
| adjacent+start/end+word | 20,000 | 20 | field-start autocomplete (정말) | 489 | 493 | 1.008 |
| adjacent+start/end+word | 100,000 | 20 | 2-char contains (영화) | 32015 | 32015 | 1.000 |
| adjacent+start/end+word | 100,000 | 20 | middle 3-char contains (서비스) | 8 | 8 | 1.000 |
| adjacent+start/end+word | 100,000 | 20 | two-word contains (정말 재미) | 510 | 526 | 1.031 |
| adjacent+start/end+word | 100,000 | 20 | field-start autocomplete (정말) | 2562 | 2577 | 1.006 |

## 관찰 범위

두 구성·두 피해 규모·두 원문 비율의 8조건 모두에서 인접 조각 해독률과 모르는 행 80%+ 해독률은 14 < 15 < 16 < 17 < 20비트 순서였다. 10만 행·5%에서는 인접만의 80%+가 16비트 3.64%, 17비트 11.53%, 20비트 43.06%였고, 시작·끝·단어 경계 구성은 각각 1.19%, 7.06%, 70.09%였다. 검색 네 종류의 후보 수는 함께 기록했으며 비트 변화의 효과는 검색어마다 다르다.

이 표는 비트 이외의 토큰 입력 구조와 공격을 같은 하네스 안에 고정한 상대 비교다. 원문 대조 공격은 누출 하한이며 빈도·동시출현·일관성 전파, 문자열 전체 복원, 길이·형식, 쿼리 관찰, 다중 스냅샷, 키 탈취 공격은 포함하지 않았다. 채택 권고나 보안 인증이 아니다. 원시 값은 [bits.json](bits.json)에 있다.
