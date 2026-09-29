# LIKE 정규화 및 A 후보 검증

연결 PID 35988에서 예열 2회·교차 7회 중앙값이다. count와 목록300 모두 fixture 평문 및 정규화 투영 값과 일치했다. B는 사용자 결정으로 실행하지 않았다.

| 조건 | 방식 | 현재 SQL ms | A SQL ms | 차이 ms |
|---|---|---:|---:|---:|
| sub_mid | count | 153.54 | 96.14 | -57.40 |
| sub_mid | list300 | 40.66 | 40.47 | -0.19 |
| word_boundary | count | 398.19 | 258.68 | -139.51 |
| word_boundary | list300 | 8.59 | 7.53 | -1.06 |
| ends | count | 447.97 | 314.42 | -133.55 |
| ends | list300 | 9.80 | 9.02 | -0.78 |
| sub_rare | count | 1.58 | 1.19 | -0.39 |
| sub_rare | list300 | 5.65 | 5.34 | -0.30 |
| zero_fragment | count | 0.37 | 0.58 | 0.21 |
| zero_fragment | list300 | 2.80 | 3.53 | 0.73 |
| sub_long | count | 80.28 | 118.83 | 38.56 |
| sub_long | list300 | 21.03 | 26.91 | 5.88 |
| sub45 | count | 17.56 | 133.71 | 116.15 |
| sub45 | list300 | 25.88 | 142.82 | 116.95 |
| like_suffix2plus | count | 377.51 | 656.22 | 278.71 |
| like_suffix2plus | list300 | 6.45 | 5.20 | -1.25 |
| NULL | count | 0.45 | 258.66 | 258.21 |
| NULL | list300 | 0.82 | 315.91 | 315.09 |
| like_general_runs | count | 1578.55 | 미적용 | — |
| like_general_runs | list300 | 17.46 | 미적용 | — |
| like_general_underscore | count | 1179.03 | 미적용 | — |
| like_general_underscore | list300 | 13.74 | 미적용 | — |

A는 반복 값·45자 및 NULL 입력의 퇴행 때문에 연기한다. NULL 행은 보호 표를 수정하지 않고 실제 후보의 길이 함수 인자를 SQL NULL로 바꿔 strict/CASE 경로를 비교했다. 저장된 NULL 행·혼합 Boolean·keyset 정확성은 제품 DB 회귀 시험에서 별도로 확인한다.

현재 제품 열에는 단일 literal LIKE 정규화가 포함된다. 일반 LIKE는 아직 기존 함수이며 두 패턴 모두 10만 건이 맞는다. 약1초를 넘으므로 별도 구간 판정 변경과 후속 검증이 필요하다. EXPLAIN·버퍼·SQL 크기·전체 시간·복호화 수 및 원 반복값은 [원시 결과](next-candidates-check.json)에 있다.

로컬 fixture 실험이며 운영 성능 보장이나 보안 인증이 아니다.
