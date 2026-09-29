# P1 독립 검증: 평문 / 이전 제품 / 새 제품

118/118항목, 3경로 모두 평문 정답과 일치했다. 각 항목·경로의 첫 실행 1회, 예열2회, 측정7회를 포함한 총 3540회 호출을 검사했다. 제품 목록의 ID 순서·정규화 값뿐 아니라 원문 공백·대소문자를 포함한 여섯 칸도 매번 일치했다.

추가 원인 확인에서 zero_and_common2 목록의 최초 악화는 선행 평문 조회에 따른 shared-buffer 재읽기 효과로 확인됐다. 선행 조건을 맞추면 이전·새 제품이 각각 약45ms 또는 약18ms로 같아진다. 아래 원시 표는 보존했으며 마지막 원인 확인 절을 함께 읽어야 한다.

이전 제품은 7c14bda와 소스·빌드 설정 차이가 없는 적재 시점 빌드를 보존해 사용했다(파일 40개 SHA-256 확인). 새 제품은 638f9c2 빌드다. 두 공개 API의 extraMigrationSql이 완전히 같아 같은 10만 행 표·함수를 공유하고 각 빌드가 생성하는 SQL로 비교했다. 제품 SQL을 벤치에서 재작성하지 않았다.

측정 기간: 2026-09-29T16:22:15.418Z ~ 2026-09-29T16:28:26.600Z. 동일 물리 연결, work_mem=4MB, max_parallel_workers_per_gather=4, 측정 락 사용. 준비 단계에서 공유 함수 재설치와 VACUUM ANALYZE를 수행했다.

첫 실행은 따로 저장했고 캐시를 비우지 않았으므로 cold 측정이 아니다. 각 조건은 예열2회 뒤 교차7회 중앙값이다. 홀수 경로 수에 맞춰 여섯 Williams 순서에서 모든 방향의 인접 경로 쌍을 두 번씩 배치했다. 일곱 번째 순서는 조건마다 순환하므로 7회 자체가 완전 균형은 아니다.

기본 55조건에는 단일 literal LIKE 3개가 이미 포함된다. 요청한 추가 LIKE3은 별도 재확인으로 표시했다. 일반 LIKE는 email의 %te%st와 %te__ 목록300이며 전체목록은 exact_common·sub_rare·exact_one이다.

## 요약

조건별 중앙값들의 산술평균·중앙값이다. 임계 초과 수는 각 조건의 중앙값 기준이며 개별 호출의 꼬리 지연이나 동시 부하를 뜻하지 않는다.

| 구간 | 지표 | 경로 | 평균 ms | 중앙값 ms | >200ms | >1초 |
|---|---|---|---:|---:|---:|---:|
| count55 | SQL 왕복 | 평문 | 32.97 | 21.02 | 0 | 0 |
| count55 | SQL 왕복 | 이전 7c14bda | 101.08 | 53.29 | 9 | 0 |
| count55 | SQL 왕복 | 새 638f9c2 | 82.05 | 52.51 | 6 | 0 |
| count55 | 전체 | 평문 | 33.04 | 21.08 | 0 | 0 |
| count55 | 전체 | 이전 7c14bda | 102.30 | 53.97 | 9 | 0 |
| count55 | 전체 | 새 638f9c2 | 83.27 | 53.28 | 6 | 0 |
| 목록300 55 | SQL 왕복 | 평문 | 21.00 | 1.55 | 1 | 0 |
| 목록300 55 | SQL 왕복 | 이전 7c14bda | 16.84 | 8.02 | 0 | 0 |
| 목록300 55 | SQL 왕복 | 새 638f9c2 | 17.28 | 8.05 | 0 | 0 |
| 목록300 55 | 전체 | 평문 | 21.07 | 1.62 | 1 | 0 |
| 목록300 55 | 전체 | 이전 7c14bda | 58.03 | 66.24 | 0 | 0 |
| 목록300 55 | 전체 | 새 638f9c2 | 59.10 | 66.52 | 0 | 0 |
| literal LIKE 재확인3 | SQL 왕복 | 평문 | 0.87 | 0.73 | 0 | 0 |
| literal LIKE 재확인3 | SQL 왕복 | 이전 7c14bda | 4.70 | 4.07 | 0 | 0 |
| literal LIKE 재확인3 | SQL 왕복 | 새 638f9c2 | 4.78 | 4.29 | 0 | 0 |
| literal LIKE 재확인3 | 전체 | 평문 | 0.93 | 0.79 | 0 | 0 |
| literal LIKE 재확인3 | 전체 | 이전 7c14bda | 27.36 | 7.42 | 0 | 0 |
| literal LIKE 재확인3 | 전체 | 새 638f9c2 | 27.90 | 7.62 | 0 | 0 |
| 일반 LIKE2 | SQL 왕복 | 평문 | 1.20 | 1.20 | 0 | 0 |
| 일반 LIKE2 | SQL 왕복 | 이전 7c14bda | 7.61 | 7.61 | 0 | 0 |
| 일반 LIKE2 | SQL 왕복 | 새 638f9c2 | 7.62 | 7.62 | 0 | 0 |
| 일반 LIKE2 | 전체 | 평문 | 1.25 | 1.25 | 0 | 0 |
| 일반 LIKE2 | 전체 | 이전 7c14bda | 68.09 | 68.09 | 0 | 0 |
| 일반 LIKE2 | 전체 | 새 638f9c2 | 66.88 | 66.88 | 0 | 0 |
| 전체목록3 | SQL 왕복 | 평문 | 121.41 | 82.12 | 1 | 0 |
| 전체목록3 | SQL 왕복 | 이전 7c14bda | 50.24 | 2.67 | 0 | 0 |
| 전체목록3 | SQL 왕복 | 새 638f9c2 | 53.28 | 2.66 | 0 | 0 |
| 전체목록3 | 전체 | 평문 | 121.48 | 82.18 | 1 | 0 |
| 전체목록3 | 전체 | 이전 7c14bda | 2468.86 | 22.24 | 1 | 1 |
| 전체목록3 | 전체 | 새 638f9c2 | 2490.67 | 22.95 | 1 | 1 |
| 전체118 | SQL 왕복 | 평문 | 28.29 | 2.57 | 2 | 0 |
| 전체118 | SQL 왕복 | 이전 7c14bda | 56.49 | 9.24 | 9 | 0 |
| 전체118 | SQL 왕복 | 새 638f9c2 | 47.90 | 9.24 | 6 | 0 |
| 전체118 | 전체 | 평문 | 28.35 | 2.66 | 2 | 0 |
| 전체118 | 전체 | 이전 7c14bda | 139.34 | 65.33 | 10 | 1 |
| 전체118 | 전체 | 새 638f9c2 | 131.52 | 64.94 | 7 | 1 |

## 이전 제품 대비 변화

차이 = 새−이전, 배수 = 새/이전(작을수록 빠름). SQL 왕복은 클라이언트 요청부터 응답까지의 합이며 DB 서버 실행 시간만을 뜻하지 않는다. 전체 시간은 토큰 준비·전송·인증 복호화·결과 구성을 포함한다.

| 구간 | 지표 | 평균 차이 ms | 평균 새/이전 | 최악 악화(절대 ms) | 최악 배수 |
|---|---|---:|---:|---|---|
| count55 | SQL 왕복 | -19.03 | 0.81× | or2 count: 12.40 | sub_zero count: 1.49× (0.17ms) |
| count55 | 전체 | -19.03 | 0.81× | or2 count: 12.45 | affix_endsWith_memo count: 1.31× (0.41ms) |
| 목록300 55 | SQL 왕복 | 0.44 | 1.03× | zero_and_common2 list300: 26.10 | zero_and_common2 list300: 2.38× (26.10ms) |
| 목록300 55 | 전체 | 1.07 | 1.02× | zero_and_common2 list300: 25.48 | zero_and_common2 list300: 2.20× (25.48ms) |
| literal LIKE 재확인3 | SQL 왕복 | 0.08 | 1.02× | like_prefix2plus list300: 0.38 | like_prefix2plus list300: 1.10× (0.38ms) |
| literal LIKE 재확인3 | 전체 | 0.54 | 1.02× | like_suffix2plus list300: 0.92 | like_prefix2plus list300: 1.08× (0.50ms) |
| 일반 LIKE2 | SQL 왕복 | 0.00 | 1.00× | like_general_segments list300: 0.13 | like_general_segments list300: 1.01× (0.13ms) |
| 일반 LIKE2 | 전체 | -1.22 | 0.98× | like_general_underscore list300: -1.12 | like_general_underscore list300: 0.98× (-1.12ms) |
| 전체목록3 | SQL 왕복 | 3.04 | 1.06× | exact_common listAll: 9.16 | exact_common listAll: 1.06× (9.16ms) |
| 전체목록3 | 전체 | 21.80 | 1.01× | exact_common listAll: 64.77 | sub_rare listAll: 1.03× (0.71ms) |
| 전체118 | SQL 왕복 | -8.58 | 0.85× | zero_and_common2 list300: 26.10 | zero_and_common2 list300: 2.38× (26.10ms) |
| 전체118 | 전체 | -7.82 | 0.94× | exact_common listAll: 64.77 | zero_and_common2 list300: 2.20× (25.48ms) |

## 조건별 SQL 왕복 시간

| 조건 | 모드·구간 | 평문 ms | 이전 ms | 새 ms | 차이 ms | 새/이전 | 정답/반환 | C 한글LIKE |
|---|---|---:|---:|---:|---:|---:|---:|---|
| coarse_company_zero | count/core | 0.60 | 26.71 | 26.96 | 0.25 | 1.01× | 0/1 |  |
| coarse_company_zero | list300/core | 0.68 | 30.76 | 30.77 | 0.01 | 1.00× | 0/0 |  |
| coarse_rare_and_memo | count/core | 2.58 | 37.67 | 36.33 | -1.33 | 0.96× | 1325/1 | 해당 |
| coarse_rare_and_memo | list300/core | 1.36 | 27.16 | 27.08 | -0.08 | 1.00× | 1325/300 | 해당 |
| coarse_zero_and_memo | count/core | 0.52 | 22.44 | 22.76 | 0.32 | 1.01× | 0/1 | 해당 |
| coarse_zero_and_memo | list300/core | 0.51 | 29.63 | 29.36 | -0.27 | 0.99× | 0/0 | 해당 |
| exact_common | count/core | 3.80 | 53.29 | 52.51 | -0.78 | 0.99× | 28331/1 |  |
| exact_common | list300/core | 1.53 | 4.90 | 4.96 | 0.06 | 1.01× | 28331/300 |  |
| sub_common_memo | count/core | 36.28 | 188.33 | 188.99 | 0.66 | 1.00× | 40097/1 | 해당 |
| sub_common_memo | list300/core | 1.38 | 7.54 | 7.41 | -0.12 | 0.98× | 40097/300 | 해당 |
| sub_mid | count/core | 19.15 | 154.01 | 151.46 | -2.55 | 0.98× | 16574/1 | 해당 |
| sub_mid | list300/core | 1.85 | 40.38 | 43.91 | 3.54 | 1.09× | 16574/300 | 해당 |
| sub_rare | count/core | 20.35 | 1.64 | 1.65 | 0.01 | 1.00× | 101/1 | 해당 |
| sub_rare | list300/core | 80.61 | 5.39 | 5.22 | -0.17 | 0.97× | 101/101 | 해당 |
| starts | count/core | 3.55 | 73.68 | 73.41 | -0.27 | 1.00× | 16574/1 | 해당 |
| starts | list300/core | 1.76 | 42.40 | 42.91 | 0.51 | 1.01× | 16574/300 | 해당 |
| ends | count/core | 32.56 | 458.21 | 168.93 | -289.29 | 0.37× | 26598/1 |  |
| ends | list300/core | 1.54 | 9.62 | 9.57 | -0.05 | 1.00× | 26598/300 |  |
| and2 | count/core | 86.97 | 166.30 | 166.43 | 0.13 | 1.00× | 21176/1 | 해당 |
| and2 | list300/core | 3.84 | 125.07 | 118.99 | -6.07 | 0.95× | 21176/300 | 해당 |
| and4 | count/core | 120.28 | 8.35 | 5.97 | -2.37 | 0.72× | 62/1 | 해당 |
| and4 | list300/core | 113.88 | 13.25 | 10.74 | -2.51 | 0.81× | 62/62 | 해당 |
| and6 | count/core | 114.94 | 28.49 | 27.53 | -0.96 | 0.97× | 624/1 | 해당 |
| and6 | list300/core | 114.77 | 27.04 | 25.22 | -1.82 | 0.93× | 624/300 | 해당 |
| or2 | count/core | 80.18 | 126.49 | 138.89 | 12.40 | 1.10× | 28400/1 | 해당 |
| or2 | list300/core | 1.54 | 6.00 | 6.04 | 0.04 | 1.01× | 28400/300 | 해당 |
| or3 | count/core | 0.38 | 0.71 | 0.62 | -0.10 | 0.86× | 2/1 |  |
| or3 | list300/core | 0.52 | 3.81 | 3.77 | -0.04 | 0.99× | 2/2 |  |
| or_and_mix | count/core | 91.51 | 168.88 | 166.80 | -2.07 | 0.99× | 21277/1 | 해당 |
| or_and_mix | list300/core | 4.01 | 123.04 | 127.29 | 4.24 | 1.03× | 21277/300 | 해당 |
| word_boundary | count/core | 35.79 | 400.75 | 190.70 | -210.05 | 0.48× | 29843/1 | 해당 |
| word_boundary | list300/core | 1.48 | 8.07 | 8.30 | 0.23 | 1.03× | 29843/300 | 해당 |
| sub45 | count/core | 22.05 | 16.46 | 15.79 | -0.67 | 0.96× | 0/1 | 해당 |
| sub45 | list300/core | 89.35 | 25.62 | 22.59 | -3.04 | 0.88× | 0/0 | 해당 |
| zero_and_common2 | count/core | 5.01 | 27.63 | 28.43 | 0.80 | 1.03× | 0/1 | 해당 |
| zero_and_common2 | list300/core | 206.03 | 18.90 | 45.00 | 26.10 | 2.38× | 0/0 | 해당 |
| zero_and_common3 | count/core | 95.21 | 5.89 | 5.35 | -0.54 | 0.91× | 0/1 | 해당 |
| zero_and_common3 | list300/core | 92.36 | 14.17 | 13.45 | -0.72 | 0.95× | 0/0 | 해당 |
| zero_fragment | count/core | 21.92 | 0.59 | 0.56 | -0.02 | 0.96× | 0/1 | 해당 |
| zero_fragment | list300/core | 70.73 | 3.16 | 2.94 | -0.22 | 0.93× | 0/0 | 해당 |
| zero_fragment_long | count/core | 21.64 | 0.58 | 0.52 | -0.06 | 0.90× | 0/1 | 해당 |
| zero_fragment_long | list300/core | 66.90 | 3.06 | 3.22 | 0.16 | 1.05× | 0/0 | 해당 |
| zero_or_all | count/core | 71.96 | 0.81 | 0.81 | -0.01 | 0.99× | 0/1 | 해당 |
| zero_or_all | list300/core | 74.45 | 5.38 | 5.46 | 0.08 | 1.01× | 0/0 | 해당 |
| exact_zero | count/core | 0.33 | 0.33 | 0.32 | -0.01 | 0.97× | 0/1 |  |
| exact_zero | list300/core | 0.38 | 2.33 | 2.16 | -0.17 | 0.93× | 0/0 |  |
| sub_zero | count/core | 21.02 | 0.34 | 0.50 | 0.17 | 1.49× | 0/1 | 해당 |
| sub_zero | list300/core | 66.85 | 2.99 | 3.03 | 0.04 | 1.01× | 0/0 | 해당 |
| or4 | count/core | 88.81 | 134.98 | 135.65 | 0.67 | 1.00× | 28401/1 | 해당 |
| or4 | list300/core | 1.82 | 7.30 | 7.16 | -0.14 | 0.98× | 28401/300 | 해당 |
| or5 | count/core | 86.05 | 133.38 | 130.68 | -2.69 | 0.98× | 40276/1 | 해당 |
| or5 | list300/core | 1.55 | 7.60 | 7.53 | -0.06 | 0.99× | 40276/300 | 해당 |
| or6 | count/core | 87.79 | 218.31 | 201.38 | -16.93 | 0.92× | 59768/1 | 해당 |
| or6 | list300/core | 1.42 | 8.30 | 8.22 | -0.08 | 0.99× | 59768/300 | 해당 |
| and2_or_and2 | count/core | 88.95 | 181.31 | 179.01 | -2.30 | 0.99× | 22846/1 | 해당 |
| and2_or_and2 | list300/core | 1.72 | 10.64 | 10.95 | 0.31 | 1.03× | 22846/300 | 해당 |
| or2_and_or2 | count/core | 89.33 | 110.82 | 104.21 | -6.61 | 0.94× | 7373/1 | 해당 |
| or2_and_or2 | list300/core | 3.46 | 16.22 | 16.32 | 0.10 | 1.01× | 7373/300 | 해당 |
| and3_or_rare | count/core | 94.59 | 75.63 | 75.24 | -0.39 | 0.99× | 3629/1 | 해당 |
| and3_or_rare | list300/core | 6.26 | 30.86 | 30.97 | 0.11 | 1.00× | 3629/300 | 해당 |
| nested3 | count/core | 96.00 | 234.62 | 231.70 | -2.92 | 0.99× | 23177/1 | 해당 |
| nested3 | list300/core | 1.94 | 14.81 | 14.60 | -0.21 | 0.99× | 23177/300 | 해당 |
| exact_mid | count/core | 0.64 | 25.88 | 25.60 | -0.29 | 0.99× | 1770/1 |  |
| exact_mid | list300/core | 1.30 | 8.75 | 8.90 | 0.15 | 1.02× | 1770/300 |  |
| exact_one | count/core | 0.27 | 0.29 | 0.32 | 0.03 | 1.11× | 1/1 |  |
| exact_one | list300/core | 0.33 | 2.24 | 1.90 | -0.34 | 0.85× | 1/1 |  |
| sub2_common | count/core | 28.45 | 115.35 | 114.24 | -1.11 | 0.99× | 30101/1 | 해당 |
| sub2_common | list300/core | 1.41 | 5.58 | 5.59 | 0.00 | 1.00× | 30101/300 | 해당 |
| sub_mid_space | count/core | 1.50 | 4.13 | 3.74 | -0.39 | 0.91× | 213/1 | 해당 |
| sub_mid_space | list300/core | 2.38 | 8.41 | 8.18 | -0.24 | 0.97× | 213/213 | 해당 |
| sub_long | count/core | 21.46 | 80.05 | 79.38 | -0.67 | 0.99× | 2440/1 | 해당 |
| sub_long | list300/core | 102.99 | 21.19 | 19.66 | -1.53 | 0.93× | 2440/300 | 해당 |
| word_inside_longer | count/core | 35.44 | 157.71 | 155.65 | -2.06 | 0.99× | 29843/1 | 해당 |
| word_inside_longer | list300/core | 1.37 | 7.21 | 7.19 | -0.02 | 1.00× | 29843/300 | 해당 |
| space_memo | count/core | 36.11 | 399.66 | 192.60 | -207.05 | 0.48× | 29843/1 | 해당 |
| space_memo | list300/core | 1.50 | 8.02 | 8.07 | 0.05 | 1.01× | 29843/300 | 해당 |
| space_address | count/core | 1.62 | 4.43 | 3.99 | -0.44 | 0.90× | 213/1 | 해당 |
| space_address | list300/core | 2.56 | 8.85 | 8.05 | -0.80 | 0.91× | 213/213 | 해당 |
| space_inside | count/core | 36.02 | 165.22 | 165.28 | 0.06 | 1.00× | 29843/1 | 해당 |
| space_inside | list300/core | 1.54 | 7.22 | 7.39 | 0.17 | 1.02× | 29843/300 | 해당 |
| affix_startsWith_name | count/core | 9.70 | 298.07 | 200.11 | -97.96 | 0.67× | 28023/1 | 해당 |
| affix_startsWith_name | list300/core | 1.43 | 7.45 | 7.55 | 0.09 | 1.01× | 28023/300 | 해당 |
| affix_endsWith_name | count/core | 0.42 | 0.62 | 0.58 | -0.04 | 0.94× | 6/1 |  |
| affix_endsWith_name | list300/core | 0.64 | 3.72 | 3.74 | 0.02 | 1.00× | 6/6 |  |
| affix_startsWith_phone | count/core | 0.92 | 14.87 | 17.52 | 2.65 | 1.18× | 1251/1 |  |
| affix_startsWith_phone | list300/core | 2.91 | 12.62 | 14.22 | 1.60 | 1.13× | 1251/300 |  |
| affix_endsWith_phone | count/core | 0.96 | 3.06 | 3.24 | 0.18 | 1.06× | 110/1 |  |
| affix_endsWith_phone | list300/core | 1.47 | 6.73 | 7.25 | 0.52 | 1.08× | 110/110 |  |
| affix_startsWith_address | count/core | 4.01 | 177.25 | 170.74 | -6.51 | 0.96× | 16526/1 | 해당 |
| affix_startsWith_address | list300/core | 2.00 | 43.66 | 48.18 | 4.52 | 1.10× | 16526/300 | 해당 |
| affix_endsWith_address | count/core | 18.71 | 101.05 | 61.80 | -39.25 | 0.61× | 10038/1 | 해당 |
| affix_endsWith_address | list300/core | 2.67 | 38.47 | 38.76 | 0.29 | 1.01× | 10038/300 | 해당 |
| affix_startsWith_memo | count/core | 0.52 | 1.71 | 1.76 | 0.05 | 1.03× | 101/1 | 해당 |
| affix_startsWith_memo | list300/core | 1.21 | 6.04 | 6.22 | 0.18 | 1.03× | 101/101 | 해당 |
| affix_endsWith_memo | count/core | 0.34 | 0.66 | 0.80 | 0.14 | 1.22× | 6/1 |  |
| affix_endsWith_memo | list300/core | 0.58 | 4.10 | 3.60 | -0.50 | 0.88× | 6/6 |  |
| affix_startsWith_email | count/core | 0.43 | 0.91 | 1.06 | 0.15 | 1.16× | 6/1 |  |
| affix_startsWith_email | list300/core | 0.60 | 3.92 | 4.72 | 0.81 | 1.21× | 6/6 |  |
| affix_endsWith_email | count/core | 24.38 | 244.86 | 243.98 | -0.87 | 1.00× | 100000/1 |  |
| affix_endsWith_email | list300/core | 1.36 | 6.95 | 6.93 | -0.02 | 1.00× | 100000/300 |  |
| affix_startsWith_company | count/core | 9.95 | 376.78 | 223.79 | -152.99 | 0.59× | 30101/1 | 해당 |
| affix_startsWith_company | list300/core | 1.63 | 7.94 | 7.59 | -0.34 | 0.96× | 30101/300 | 해당 |
| affix_endsWith_company | count/core | 16.23 | 56.63 | 56.44 | -0.19 | 1.00× | 5883/1 | 해당 |
| affix_endsWith_company | list300/core | 4.09 | 17.28 | 17.50 | 0.21 | 1.01× | 5883/300 | 해당 |
| like_prefix2plus | count/core | 0.57 | 1.18 | 1.37 | 0.20 | 1.17× | 6/1 |  |
| like_prefix2plus | list300/core | 0.79 | 4.24 | 4.41 | 0.17 | 1.04× | 6/6 |  |
| like_suffix2plus | count/core | 24.42 | 270.85 | 257.90 | -12.95 | 0.95× | 100000/1 |  |
| like_suffix2plus | list300/core | 1.27 | 6.29 | 6.15 | -0.15 | 0.98× | 100000/300 |  |
| like_contains2plus | count/core | 0.36 | 0.70 | 0.78 | 0.08 | 1.11× | 9/1 |  |
| like_contains2plus | list300/core | 0.63 | 3.69 | 3.56 | -0.14 | 0.96× | 9/9 |  |
| like_prefix2plus | list300/literalLikeRepeat | 0.56 | 3.92 | 4.29 | 0.38 | 1.10× | 6/6 |  |
| like_suffix2plus | list300/literalLikeRepeat | 1.31 | 6.11 | 6.07 | -0.04 | 0.99× | 100000/300 |  |
| like_contains2plus | list300/literalLikeRepeat | 0.73 | 4.07 | 3.97 | -0.11 | 0.97× | 9/9 |  |
| like_general_segments | list300/generalLike | 1.19 | 8.60 | 8.73 | 0.13 | 1.01× | 100000/300 |  |
| like_general_underscore | list300/generalLike | 1.20 | 6.63 | 6.51 | -0.12 | 0.98× | 100000/300 |  |
| exact_common | listAll/wholeList | 281.81 | 147.54 | 156.71 | 9.16 | 1.06× | 28331/28331 |  |
| sub_rare | listAll/wholeList | 82.12 | 2.67 | 2.66 | -0.01 | 1.00× | 101/101 | 해당 |
| exact_one | listAll/wholeList | 0.31 | 0.51 | 0.46 | -0.04 | 0.92× | 1/1 |  |

## 조건별 전체 API 시간

| 조건 | 모드·구간 | 평문 ms | 이전 ms | 새 ms | 차이 ms | 새/이전 | 정답/반환 | C 한글LIKE |
|---|---|---:|---:|---:|---:|---:|---:|---|
| coarse_company_zero | count/core | 0.69 | 27.65 | 27.72 | 0.07 | 1.00× | 0/1 |  |
| coarse_company_zero | list300/core | 0.73 | 32.35 | 32.42 | 0.07 | 1.00× | 0/0 |  |
| coarse_rare_and_memo | count/core | 2.68 | 38.98 | 37.60 | -1.37 | 0.96× | 1325/1 | 해당 |
| coarse_rare_and_memo | list300/core | 1.44 | 86.44 | 88.55 | 2.12 | 1.02× | 1325/300 | 해당 |
| coarse_zero_and_memo | count/core | 0.57 | 23.53 | 23.75 | 0.22 | 1.01× | 0/1 | 해당 |
| coarse_zero_and_memo | list300/core | 0.56 | 31.51 | 31.23 | -0.28 | 0.99× | 0/0 | 해당 |
| exact_common | count/core | 3.87 | 53.97 | 53.28 | -0.68 | 0.99× | 28331/1 |  |
| exact_common | list300/core | 1.59 | 65.29 | 64.83 | -0.47 | 0.99× | 28331/300 |  |
| sub_common_memo | count/core | 36.35 | 189.45 | 189.89 | 0.44 | 1.00× | 40097/1 | 해당 |
| sub_common_memo | list300/core | 1.46 | 69.88 | 71.36 | 1.48 | 1.02× | 40097/300 | 해당 |
| sub_mid | count/core | 19.23 | 154.92 | 152.34 | -2.58 | 0.98× | 16574/1 | 해당 |
| sub_mid | list300/core | 1.94 | 103.86 | 103.45 | -0.40 | 1.00× | 16574/300 | 해당 |
| sub_rare | count/core | 20.41 | 2.53 | 2.58 | 0.05 | 1.02× | 101/1 | 해당 |
| sub_rare | list300/core | 80.74 | 25.82 | 25.81 | -0.01 | 1.00× | 101/101 | 해당 |
| starts | count/core | 3.61 | 74.51 | 74.33 | -0.18 | 1.00× | 16574/1 | 해당 |
| starts | list300/core | 1.82 | 101.98 | 104.07 | 2.09 | 1.02× | 16574/300 | 해당 |
| ends | count/core | 32.63 | 459.84 | 170.31 | -289.53 | 0.37× | 26598/1 |  |
| ends | list300/core | 1.61 | 72.05 | 75.43 | 3.38 | 1.05× | 26598/300 |  |
| and2 | count/core | 87.05 | 167.61 | 167.54 | -0.07 | 1.00× | 21176/1 | 해당 |
| and2 | list300/core | 3.91 | 180.93 | 179.04 | -1.89 | 0.99× | 21176/300 | 해당 |
| and4 | count/core | 120.36 | 10.34 | 8.01 | -2.34 | 0.77× | 62/1 | 해당 |
| and4 | list300/core | 113.96 | 28.94 | 25.91 | -3.02 | 0.90× | 62/62 | 해당 |
| and6 | count/core | 115.03 | 30.80 | 29.88 | -0.92 | 0.97× | 624/1 | 해당 |
| and6 | list300/core | 114.85 | 88.76 | 88.46 | -0.30 | 1.00× | 624/300 | 해당 |
| or2 | count/core | 80.26 | 127.50 | 139.95 | 12.45 | 1.10× | 28400/1 | 해당 |
| or2 | list300/core | 1.62 | 66.24 | 66.52 | 0.28 | 1.00× | 28400/300 | 해당 |
| or3 | count/core | 0.40 | 2.11 | 1.77 | -0.35 | 0.84× | 2/1 |  |
| or3 | list300/core | 0.60 | 6.64 | 6.58 | -0.06 | 0.99× | 2/2 |  |
| or_and_mix | count/core | 91.60 | 170.68 | 168.68 | -2.00 | 0.99× | 21277/1 | 해당 |
| or_and_mix | list300/core | 4.09 | 189.23 | 195.84 | 6.61 | 1.03× | 21277/300 | 해당 |
| word_boundary | count/core | 35.86 | 401.81 | 191.82 | -209.99 | 0.48× | 29843/1 | 해당 |
| word_boundary | list300/core | 1.54 | 67.20 | 69.80 | 2.60 | 1.04× | 29843/300 | 해당 |
| sub45 | count/core | 22.12 | 18.48 | 17.93 | -0.55 | 0.97× | 0/1 | 해당 |
| sub45 | list300/core | 89.43 | 29.18 | 25.54 | -3.64 | 0.88× | 0/0 | 해당 |
| zero_and_common2 | count/core | 5.09 | 28.73 | 29.56 | 0.82 | 1.03× | 0/1 | 해당 |
| zero_and_common2 | list300/core | 206.12 | 21.27 | 46.75 | 25.48 | 2.20× | 0/0 | 해당 |
| zero_and_common3 | count/core | 95.27 | 7.07 | 6.65 | -0.43 | 0.94× | 0/1 | 해당 |
| zero_and_common3 | list300/core | 92.45 | 16.55 | 15.91 | -0.64 | 0.96× | 0/0 | 해당 |
| zero_fragment | count/core | 21.98 | 1.56 | 1.46 | -0.10 | 0.94× | 0/1 | 해당 |
| zero_fragment | list300/core | 70.81 | 4.85 | 4.62 | -0.23 | 0.95× | 0/0 | 해당 |
| zero_fragment_long | count/core | 21.71 | 2.00 | 1.92 | -0.08 | 0.96× | 0/1 | 해당 |
| zero_fragment_long | list300/core | 66.98 | 5.30 | 5.32 | 0.02 | 1.00× | 0/0 | 해당 |
| zero_or_all | count/core | 72.01 | 2.52 | 2.38 | -0.14 | 0.94× | 0/1 | 해당 |
| zero_or_all | list300/core | 74.54 | 8.31 | 8.57 | 0.26 | 1.03× | 0/0 | 해당 |
| exact_zero | count/core | 0.37 | 0.87 | 0.89 | 0.02 | 1.02× | 0/1 |  |
| exact_zero | list300/core | 0.43 | 3.44 | 3.30 | -0.14 | 0.96× | 0/0 |  |
| sub_zero | count/core | 21.08 | 1.00 | 1.30 | 0.30 | 1.30× | 0/1 | 해당 |
| sub_zero | list300/core | 66.94 | 4.40 | 4.66 | 0.26 | 1.06× | 0/0 | 해당 |
| or4 | count/core | 88.90 | 136.68 | 137.42 | 0.74 | 1.01× | 28401/1 | 해당 |
| or4 | list300/core | 1.91 | 72.30 | 70.05 | -2.25 | 0.97× | 28401/300 | 해당 |
| or5 | count/core | 86.14 | 135.58 | 133.21 | -2.37 | 0.98× | 40276/1 | 해당 |
| or5 | list300/core | 1.62 | 70.10 | 70.50 | 0.40 | 1.01× | 40276/300 | 해당 |
| or6 | count/core | 87.88 | 221.13 | 204.21 | -16.92 | 0.92× | 59768/1 | 해당 |
| or6 | list300/core | 1.46 | 74.16 | 72.90 | -1.26 | 0.98× | 59768/300 | 해당 |
| and2_or_and2 | count/core | 89.03 | 182.85 | 180.58 | -2.27 | 0.99× | 22846/1 | 해당 |
| and2_or_and2 | list300/core | 1.81 | 70.77 | 70.82 | 0.05 | 1.00× | 22846/300 | 해당 |
| or2_and_or2 | count/core | 89.41 | 112.81 | 106.23 | -6.58 | 0.94× | 7373/1 | 해당 |
| or2_and_or2 | list300/core | 3.54 | 77.65 | 78.46 | 0.81 | 1.01× | 7373/300 | 해당 |
| and3_or_rare | count/core | 94.67 | 77.38 | 76.96 | -0.42 | 0.99× | 3629/1 | 해당 |
| and3_or_rare | list300/core | 6.33 | 90.33 | 92.16 | 1.83 | 1.02× | 3629/300 | 해당 |
| nested3 | count/core | 96.07 | 236.82 | 234.10 | -2.73 | 0.99× | 23177/1 | 해당 |
| nested3 | list300/core | 2.01 | 82.62 | 79.47 | -3.15 | 0.96× | 23177/300 | 해당 |
| exact_mid | count/core | 0.68 | 26.51 | 26.20 | -0.31 | 0.99× | 1770/1 |  |
| exact_mid | list300/core | 1.35 | 65.37 | 65.63 | 0.26 | 1.00× | 1770/300 |  |
| exact_one | count/core | 0.29 | 0.70 | 0.72 | 0.01 | 1.02× | 1/1 |  |
| exact_one | list300/core | 0.36 | 3.51 | 3.24 | -0.28 | 0.92× | 1/1 |  |
| sub2_common | count/core | 28.52 | 116.07 | 114.97 | -1.10 | 0.99× | 30101/1 | 해당 |
| sub2_common | list300/core | 1.46 | 64.80 | 62.14 | -2.65 | 0.96× | 30101/300 | 해당 |
| sub_mid_space | count/core | 1.53 | 5.08 | 4.68 | -0.39 | 0.92× | 213/1 | 해당 |
| sub_mid_space | list300/core | 2.43 | 50.69 | 51.47 | 0.78 | 1.02× | 213/213 | 해당 |
| sub_long | count/core | 21.53 | 81.49 | 80.92 | -0.57 | 0.99× | 2440/1 | 해당 |
| sub_long | list300/core | 103.07 | 84.41 | 84.52 | 0.12 | 1.00× | 2440/300 | 해당 |
| word_inside_longer | count/core | 35.50 | 158.94 | 156.71 | -2.23 | 0.99× | 29843/1 | 해당 |
| word_inside_longer | list300/core | 1.42 | 64.56 | 65.96 | 1.41 | 1.02× | 29843/300 | 해당 |
| space_memo | count/core | 36.17 | 400.62 | 193.80 | -206.82 | 0.48× | 29843/1 | 해당 |
| space_memo | list300/core | 1.56 | 68.67 | 69.60 | 0.93 | 1.01× | 29843/300 | 해당 |
| space_address | count/core | 1.66 | 5.51 | 4.95 | -0.55 | 0.90× | 213/1 | 해당 |
| space_address | list300/core | 2.64 | 55.57 | 57.01 | 1.44 | 1.03× | 213/213 | 해당 |
| space_inside | count/core | 36.09 | 166.09 | 166.31 | 0.22 | 1.00× | 29843/1 | 해당 |
| space_inside | list300/core | 1.59 | 67.47 | 70.44 | 2.97 | 1.04× | 29843/300 | 해당 |
| affix_startsWith_name | count/core | 9.77 | 299.15 | 201.16 | -97.99 | 0.67× | 28023/1 | 해당 |
| affix_startsWith_name | list300/core | 1.49 | 68.22 | 70.06 | 1.84 | 1.03× | 28023/300 | 해당 |
| affix_endsWith_name | count/core | 0.46 | 1.37 | 1.29 | -0.08 | 0.94× | 6/1 |  |
| affix_endsWith_name | list300/core | 0.69 | 6.63 | 6.26 | -0.37 | 0.94× | 6/6 |  |
| affix_startsWith_phone | count/core | 0.97 | 15.74 | 18.42 | 2.68 | 1.17× | 1251/1 |  |
| affix_startsWith_phone | list300/core | 2.99 | 86.56 | 94.91 | 8.35 | 1.10× | 1251/300 |  |
| affix_endsWith_phone | count/core | 1.01 | 3.98 | 4.10 | 0.12 | 1.03× | 110/1 |  |
| affix_endsWith_phone | list300/core | 1.56 | 36.50 | 36.95 | 0.45 | 1.01× | 110/110 |  |
| affix_startsWith_address | count/core | 4.09 | 178.54 | 171.95 | -6.59 | 0.96× | 16526/1 | 해당 |
| affix_startsWith_address | list300/core | 2.05 | 122.13 | 129.27 | 7.14 | 1.06× | 16526/300 | 해당 |
| affix_endsWith_address | count/core | 18.78 | 102.38 | 62.76 | -39.62 | 0.61× | 10038/1 | 해당 |
| affix_endsWith_address | list300/core | 2.76 | 113.89 | 118.35 | 4.46 | 1.04× | 10038/300 | 해당 |
| affix_startsWith_memo | count/core | 0.57 | 2.63 | 2.70 | 0.07 | 1.03× | 101/1 | 해당 |
| affix_startsWith_memo | list300/core | 1.29 | 34.58 | 35.81 | 1.23 | 1.04× | 101/101 | 해당 |
| affix_endsWith_memo | count/core | 0.37 | 1.32 | 1.73 | 0.41 | 1.31× | 6/1 |  |
| affix_endsWith_memo | list300/core | 0.61 | 7.22 | 6.56 | -0.66 | 0.91× | 6/6 |  |
| affix_startsWith_email | count/core | 0.46 | 1.64 | 1.90 | 0.26 | 1.16× | 6/1 |  |
| affix_startsWith_email | list300/core | 0.63 | 7.06 | 7.52 | 0.46 | 1.07× | 6/6 |  |
| affix_endsWith_email | count/core | 24.45 | 245.73 | 244.89 | -0.85 | 1.00× | 100000/1 |  |
| affix_endsWith_email | list300/core | 1.42 | 79.66 | 83.05 | 3.39 | 1.04× | 100000/300 |  |
| affix_startsWith_company | count/core | 10.02 | 377.74 | 224.79 | -152.94 | 0.60× | 30101/1 | 해당 |
| affix_startsWith_company | list300/core | 1.69 | 89.00 | 89.21 | 0.20 | 1.00× | 30101/300 | 해당 |
| affix_endsWith_company | count/core | 16.30 | 57.71 | 57.57 | -0.15 | 1.00× | 5883/1 | 해당 |
| affix_endsWith_company | list300/core | 4.16 | 84.08 | 81.94 | -2.14 | 0.97× | 5883/300 | 해당 |
| like_prefix2plus | count/core | 0.63 | 2.39 | 2.55 | 0.16 | 1.06× | 6/1 |  |
| like_prefix2plus | list300/core | 0.85 | 7.14 | 7.54 | 0.40 | 1.06× | 6/6 |  |
| like_suffix2plus | count/core | 24.49 | 271.92 | 258.89 | -13.03 | 0.95× | 100000/1 |  |
| like_suffix2plus | list300/core | 1.33 | 68.67 | 68.02 | -0.65 | 0.99× | 100000/300 |  |
| like_contains2plus | count/core | 0.39 | 1.38 | 1.50 | 0.12 | 1.09× | 9/1 |  |
| like_contains2plus | list300/core | 0.67 | 6.74 | 6.64 | -0.10 | 0.99× | 9/9 |  |
| like_prefix2plus | list300/literalLikeRepeat | 0.59 | 6.62 | 7.12 | 0.50 | 1.08× | 6/6 |  |
| like_suffix2plus | list300/literalLikeRepeat | 1.40 | 68.05 | 68.97 | 0.92 | 1.01× | 100000/300 |  |
| like_contains2plus | list300/literalLikeRepeat | 0.79 | 7.42 | 7.62 | 0.19 | 1.03× | 9/9 |  |
| like_general_segments | list300/generalLike | 1.25 | 70.02 | 68.71 | -1.31 | 0.98× | 100000/300 |  |
| like_general_underscore | list300/generalLike | 1.25 | 66.17 | 65.05 | -1.12 | 0.98× | 100000/300 |  |
| exact_common | listAll/wholeList | 281.92 | 7382.96 | 7447.73 | 64.77 | 1.01× | 28331/28331 |  |
| sub_rare | listAll/wholeList | 82.18 | 22.24 | 22.95 | 0.71 | 1.03× | 101/101 | 해당 |
| exact_one | listAll/wholeList | 0.33 | 1.39 | 1.32 | -0.07 | 0.95× | 1/1 |  |

## SQL 호출·전송·인증 복호화

아래 수치는 실제 호출 계측 중앙값이다. 전송 행은 DB 응답 rows 합계이며 SQL 내부에서 판정한 후보 행 수와 다르다. SQL 내부 후보·판정 루프 수는 이번 측정에서 별도 계측하지 않았다. count의 반환은 정확한 정수 하나이며 표의 반환1은 응답 레코드 수를 뜻한다.

| 조건 | 모드·구간 | 이전 SQL/전송행/open | 새 SQL/전송행/open | 이전→새 후보 토큰 길이 |
|---|---|---|---|---|
| coarse_company_zero | count/core | 1/1/0 | 1/1/0 | 없음 → 없음 |
| coarse_company_zero | list300/core | 1/0/0 | 1/0/0 | 없음 → 없음 |
| coarse_rare_and_memo | count/core | 1/1/0 | 1/1/0 | 3 → 3 |
| coarse_rare_and_memo | list300/core | 1/300/1800 | 1/300/1800 | 3,3,3 → 3,3,3 |
| coarse_zero_and_memo | count/core | 1/1/0 | 1/1/0 | 3 → 3 |
| coarse_zero_and_memo | list300/core | 1/0/0 | 1/0/0 | 3,3,3 → 3,3,3 |
| exact_common | count/core | 1/1/0 | 1/1/0 | 없음 → 없음 |
| exact_common | list300/core | 1/300/1800 | 1/300/1800 | 없음 → 없음 |
| sub_common_memo | count/core | 1/1/0 | 1/1/0 | 3 → 3 |
| sub_common_memo | list300/core | 1/300/1800 | 1/300/1800 | 3,3,3 → 3,3,3 |
| sub_mid | count/core | 1/1/0 | 1/1/0 | 5 → 3 |
| sub_mid | list300/core | 1/300/1800 | 1/300/1800 | 5,5,5 → 3,3,3 |
| sub_rare | count/core | 1/1/0 | 1/1/0 | 3 → 3 |
| sub_rare | list300/core | 1/101/606 | 1/101/606 | 3,3,3 → 3,3,3 |
| starts | count/core | 1/1/0 | 1/1/0 | 2 → 2 |
| starts | list300/core | 1/300/1800 | 1/300/1800 | 2,2,2 → 2,2,2 |
| ends | count/core | 1/1/0 | 1/1/0 | 14 → 3 |
| ends | list300/core | 1/300/1800 | 1/300/1800 | 14,14,14 → 3,3,3 |
| and2 | count/core | 1/1/0 | 1/1/0 | 3 → 3 |
| and2 | list300/core | 1/300/1800 | 1/300/1800 | 3,3,3 → 3,3,3 |
| and4 | count/core | 1/1/0 | 1/1/0 | 1,1,11 → 1,1,3 |
| and4 | list300/core | 1/62/372 | 1/62/372 | 1,1,11,1,1,11,1,1,11 → 1,1,3,1,1,3,1,1,3 |
| and6 | count/core | 1/1/0 | 1/1/0 | 1,1,1,3,5 → 1,1,1,3,3 |
| and6 | list300/core | 1/300/1800 | 1/300/1800 | 1,1,1,3,5,1,1,1,3,5,1,1,1,3,5 → 1,1,1,3,3,1,1,1,3,3,1,1,1,3,3 |
| or2 | count/core | 1/1/0 | 1/1/0 | 3 → 3 |
| or2 | list300/core | 1/300/1800 | 1/300/1800 | 3,3,3 → 3,3,3 |
| or3 | count/core | 1/1/0 | 1/1/0 | 7 → 3 |
| or3 | list300/core | 1/2/12 | 1/2/12 | 7,7,7 → 3,3,3 |
| or_and_mix | count/core | 1/1/0 | 1/1/0 | 3,3 → 3,3 |
| or_and_mix | list300/core | 1/300/1800 | 1/300/1800 | 3,3,3,3,3,3 → 3,3,3,3,3,3 |
| word_boundary | count/core | 1/1/0 | 1/1/0 | 7 → 3 |
| word_boundary | list300/core | 1/300/1800 | 1/300/1800 | 7,7,7 → 3,3,3 |
| sub45 | count/core | 1/1/0 | 1/1/0 | 18 → 3 |
| sub45 | list300/core | 1/0/0 | 1/0/0 | 18,18,18 → 3,3,3 |
| zero_and_common2 | count/core | 1/1/0 | 1/1/0 | 1 → 1 |
| zero_and_common2 | list300/core | 1/0/0 | 1/0/0 | 1,1,1 → 1,1,1 |
| zero_and_common3 | count/core | 1/1/0 | 1/1/0 | 1,3 → 1,3 |
| zero_and_common3 | list300/core | 1/0/0 | 1/0/0 | 1,3,1,3,1,3 → 1,3,1,3,1,3 |
| zero_fragment | count/core | 1/1/0 | 1/1/0 | 7 → 3 |
| zero_fragment | list300/core | 1/0/0 | 1/0/0 | 7,7,7 → 3,3,3 |
| zero_fragment_long | count/core | 1/1/0 | 1/1/0 | 14 → 3 |
| zero_fragment_long | list300/core | 1/0/0 | 1/0/0 | 14,14,14 → 3,3,3 |
| zero_or_all | count/core | 1/1/0 | 1/1/0 | 7,5,5 → 3,3,3 |
| zero_or_all | list300/core | 1/0/0 | 1/0/0 | 7,5,5,7,5,5,7,5,5 → 3,3,3,3,3,3,3,3,3 |
| exact_zero | count/core | 1/1/0 | 1/1/0 | 없음 → 없음 |
| exact_zero | list300/core | 1/0/0 | 1/0/0 | 없음 → 없음 |
| sub_zero | count/core | 1/1/0 | 1/1/0 | 5 → 3 |
| sub_zero | list300/core | 1/0/0 | 1/0/0 | 5,5,5 → 3,3,3 |
| or4 | count/core | 1/1/0 | 1/1/0 | 3,7 → 3,3 |
| or4 | list300/core | 1/300/1800 | 1/300/1800 | 3,7,3,7,3,7 → 3,3,3,3,3,3 |
| or5 | count/core | 1/1/0 | 1/1/0 | 3,7,5 → 3,3,3 |
| or5 | list300/core | 1/300/1800 | 1/300/1800 | 3,7,5,3,7,5,3,7,5 → 3,3,3,3,3,3,3,3,3 |
| or6 | count/core | 1/1/0 | 1/1/0 | 3,7,5,14 → 3,3,3,3 |
| or6 | list300/core | 1/300/1800 | 1/300/1800 | 3,7,5,14,3,7,5,14,3,7,5,14 → 3,3,3,3,3,3,3,3,3,3,3,3 |
| and2_or_and2 | count/core | 1/1/0 | 1/1/0 | 3,1,1 → 3,1,1 |
| and2_or_and2 | list300/core | 1/300/1800 | 1/300/1800 | 3,1,1,3,1,1,3,1,1 → 3,1,1,3,1,1,3,1,1 |
| or2_and_or2 | count/core | 1/1/0 | 1/1/0 | 3,1,11 → 3,1,3 |
| or2_and_or2 | list300/core | 1/300/1800 | 1/300/1800 | 3,1,11,3,1,11,3,1,11 → 3,1,3,3,1,3,3,1,3 |
| and3_or_rare | count/core | 1/1/0 | 1/1/0 | 3,1,3 → 3,1,3 |
| and3_or_rare | list300/core | 1/300/1800 | 1/300/1800 | 3,1,3,3,1,3,3,1,3 → 3,1,3,3,1,3,3,1,3 |
| nested3 | count/core | 1/1/0 | 1/1/0 | 3,1,5,1,1 → 3,1,3,1,1 |
| nested3 | list300/core | 1/300/1800 | 1/300/1800 | 3,1,5,1,1,3,1,5,1,1,3,1,5,1,1 → 3,1,3,1,1,3,1,3,1,1,3,1,3,1,1 |
| exact_mid | count/core | 1/1/0 | 1/1/0 | 없음 → 없음 |
| exact_mid | list300/core | 1/300/1800 | 1/300/1800 | 없음 → 없음 |
| exact_one | count/core | 1/1/0 | 1/1/0 | 없음 → 없음 |
| exact_one | list300/core | 1/1/6 | 1/1/6 | 없음 → 없음 |
| sub2_common | count/core | 1/1/0 | 1/1/0 | 1 → 1 |
| sub2_common | list300/core | 1/300/1800 | 1/300/1800 | 1,1,1 → 1,1,1 |
| sub_mid_space | count/core | 1/1/0 | 1/1/0 | 9 → 3 |
| sub_mid_space | list300/core | 1/213/1278 | 1/213/1278 | 9,9,9 → 3,3,3 |
| sub_long | count/core | 1/1/0 | 1/1/0 | 18 → 3 |
| sub_long | list300/core | 1/300/1800 | 1/300/1800 | 18,18,18 → 3,3,3 |
| word_inside_longer | count/core | 1/1/0 | 1/1/0 | 3 → 3 |
| word_inside_longer | list300/core | 1/300/1800 | 1/300/1800 | 3,3,3 → 3,3,3 |
| space_memo | count/core | 1/1/0 | 1/1/0 | 7 → 3 |
| space_memo | list300/core | 1/300/1800 | 1/300/1800 | 7,7,7 → 3,3,3 |
| space_address | count/core | 1/1/0 | 1/1/0 | 9 → 3 |
| space_address | list300/core | 1/213/1278 | 1/213/1278 | 9,9,9 → 3,3,3 |
| space_inside | count/core | 1/1/0 | 1/1/0 | 3 → 3 |
| space_inside | list300/core | 1/300/1800 | 1/300/1800 | 3,3,3 → 3,3,3 |
| affix_startsWith_name | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_startsWith_name | list300/core | 1/300/1800 | 1/300/1800 | 4,4,4 → 3,3,3 |
| affix_endsWith_name | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_endsWith_name | list300/core | 1/6/36 | 1/6/36 | 4,4,4 → 3,3,3 |
| affix_startsWith_phone | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_startsWith_phone | list300/core | 1/300/1800 | 1/300/1800 | 4,4,4 → 3,3,3 |
| affix_endsWith_phone | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_endsWith_phone | list300/core | 1/110/660 | 1/110/660 | 4,4,4 → 3,3,3 |
| affix_startsWith_address | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_startsWith_address | list300/core | 1/300/1800 | 1/300/1800 | 4,4,4 → 3,3,3 |
| affix_endsWith_address | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_endsWith_address | list300/core | 1/300/1800 | 1/300/1800 | 4,4,4 → 3,3,3 |
| affix_startsWith_memo | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_startsWith_memo | list300/core | 1/101/606 | 1/101/606 | 4,4,4 → 3,3,3 |
| affix_endsWith_memo | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_endsWith_memo | list300/core | 1/6/36 | 1/6/36 | 4,4,4 → 3,3,3 |
| affix_startsWith_email | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_startsWith_email | list300/core | 1/6/36 | 1/6/36 | 4,4,4 → 3,3,3 |
| affix_endsWith_email | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_endsWith_email | list300/core | 1/300/1800 | 1/300/1800 | 4,4,4 → 3,3,3 |
| affix_startsWith_company | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_startsWith_company | list300/core | 1/300/1800 | 1/300/1800 | 4,4,4 → 3,3,3 |
| affix_endsWith_company | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| affix_endsWith_company | list300/core | 1/300/1800 | 1/300/1800 | 4,4,4 → 3,3,3 |
| like_prefix2plus | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| like_prefix2plus | list300/core | 1/6/36 | 1/6/36 | 4,4,4 → 3,3,3 |
| like_suffix2plus | count/core | 1/1/0 | 1/1/0 | 4 → 3 |
| like_suffix2plus | list300/core | 1/300/1800 | 1/300/1800 | 4,4,4 → 3,3,3 |
| like_contains2plus | count/core | 1/1/0 | 1/1/0 | 3 → 3 |
| like_contains2plus | list300/core | 1/9/54 | 1/9/54 | 3,3,3 → 3,3,3 |
| like_prefix2plus | list300/literalLikeRepeat | 1/6/36 | 1/6/36 | 4,4,4 → 3,3,3 |
| like_suffix2plus | list300/literalLikeRepeat | 1/300/1800 | 1/300/1800 | 4,4,4 → 3,3,3 |
| like_contains2plus | list300/literalLikeRepeat | 1/9/54 | 1/9/54 | 3,3,3 → 3,3,3 |
| like_general_segments | list300/generalLike | 1/300/1800 | 1/300/1800 | 2,2,2 → 2,2,2 |
| like_general_underscore | list300/generalLike | 1/300/1800 | 1/300/1800 | 1,1,1 → 1,1,1 |
| exact_common | listAll/wholeList | 1/28331/169986 | 1/28331/169986 | 없음 → 없음 |
| sub_rare | listAll/wholeList | 1/101/606 | 1/101/606 | 3 → 3 |
| exact_one | listAll/wholeList | 1/1/6 | 1/1/6 | 없음 → 없음 |

## 질의 정의

| 조건 | 정규화 전 공개 API 조건 |
|---|---|
| coarse_company_zero | company eq "없는회사0" |
| coarse_rare_and_memo | (company eq "서울서비스 중앙지사" AND memo contains "서비스") |
| coarse_zero_and_memo | (company eq "없는회사0" AND memo contains "서비스") |
| exact_common | company eq "서울서비스 담당" |
| sub_common_memo | memo contains "서비스" |
| sub_mid | address contains "세종대로" |
| sub_rare | memo contains "푸른달" |
| starts | address startsWith "서울" |
| ends | email endsWith "biz.test" |
| and2 | (company eq "서울서비스 담당" AND memo contains "서비스") |
| and4 | (company eq "서울서비스 담당" AND address contains "서울" AND memo contains "상담" AND email contains "service") |
| and6 | (name contains "민서" AND phone contains "-5" AND address contains "서울" AND memo contains "서비스" AND email contains "test" AND company eq "서울서비스 담당") |
| or2 | (company eq "서울서비스 담당" OR memo contains "푸른달") |
| or3 | (phone eq "42-5748-1542" OR phone eq "21-7100-5875" OR name contains "pshxt") |
| or_and_mix | ((company eq "서울서비스 담당" AND memo contains "서비스") OR memo contains "푸른달") |
| word_boundary | memo contains "서비스 상담" |
| sub45 | memo contains "상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용상세안내와확인내용" |
| zero_and_common2 | (company eq "서울서비스 담당" AND company contains "물류") |
| zero_and_common3 | (company eq "서울서비스 담당" AND company contains "물류" AND memo contains "서비스") |
| zero_fragment | memo contains "상담서비스" |
| zero_fragment_long | memo contains "서비스상담서비스상담요청" |
| zero_or_all | (memo contains "상담서비스" OR name contains "서비스상" OR address contains "담당서울") |
| exact_zero | phone eq "99-0000-0000" |
| sub_zero | memo contains "없는표식" |
| or4 | (company eq "서울서비스 담당" OR memo contains "푸른달" OR phone eq "42-5748-1542" OR name contains "pshxt") |
| or5 | (company eq "서울서비스 담당" OR memo contains "푸른달" OR phone eq "42-5748-1542" OR name contains "pshxt" OR address contains "세종대로") |
| or6 | (company eq "서울서비스 담당" OR memo contains "푸른달" OR phone eq "42-5748-1542" OR name contains "pshxt" OR address contains "세종대로" OR email endsWith "biz.test") |
| and2_or_and2 | ((company eq "서울서비스 담당" AND memo contains "서비스") OR (address contains "서울" AND memo contains "상담")) |
| or2_and_or2 | ((company eq "서울서비스 담당" OR memo contains "푸른달") AND (address contains "서울" OR email contains "service")) |
| and3_or_rare | ((company eq "서울서비스 담당" AND memo contains "서비스" AND address contains "서울") OR memo contains "푸른달") |
| nested3 | (((company eq "서울서비스 담당" AND memo contains "서비스") OR (address contains "서울" AND email contains "test")) AND (phone contains "-5" OR name contains "민서")) |
| exact_mid | company eq "서울서비스 중앙지사" |
| exact_one | phone eq "42-5748-1542" |
| sub2_common | company contains "서비" |
| sub_mid_space | address contains "세종대로 25" |
| sub_long | memo contains "상세 안내와 확인 내용 상세 안내와" |
| word_inside_longer | memo contains "비스 상" |
| space_memo | memo contains "서비스 상담" |
| space_address | address contains "세종대로 25" |
| space_inside | memo contains "비스 상" |
| affix_startsWith_name | name startsWith "김민서" |
| affix_endsWith_name | name endsWith "rjq" |
| affix_startsWith_phone | phone startsWith "41-" |
| affix_endsWith_phone | phone endsWith "813" |
| affix_startsWith_address | address startsWith "대전유" |
| affix_endsWith_address | address endsWith "1고객" |
| affix_startsWith_memo | memo startsWith "희귀표" |
| affix_endsWith_memo | memo endsWith "rjq" |
| affix_startsWith_email | email startsWith "iae" |
| affix_endsWith_email | email endsWith "est" |
| affix_startsWith_company | company startsWith "서울서" |
| affix_endsWith_company | company endsWith "앙지사" |
| like_prefix2plus | email like "iae%" |
| like_suffix2plus | email like "%est" |
| like_contains2plus | email like "%eea%" |
| like_general_segments | email like "%te%st" |
| like_general_underscore | email like "%te__" |

## 근거와 한계

- [전체 반복·첫 실행·SQL·세션·정답 기록](measure.json), [요약 JSON](summary.json), [보존 빌드](baseline-build.json), [새 빌드](new-build.json), [적재 기록](load.json), [적재 보고](load-report-ko.md).
- [공개 API 측정 코드](../../../p1-verify/v-astra/run.ts), [계측](../../../p1-verify/v-astra/instrument.ts), [보고 생성](../../../p1-verify/v-astra/report.ts).
- 평문 oracle는 보호 fixture 원문에 제품 정규화를 적용한 메모리 판정이다. 시간 기준은 같은 fixture의 정규화 평문 SQL이며 매 호출마다 두 결과를 대조했다. 목록은 ID 오름차순·같은 여섯 칸을 반환한다.
- C 로캘의 한글 평문 LIKE는 전체 스캔할 수 있다. 해당 조건은 표에 표시했으며 평문 대비 속도 우위를 성능 주장으로 사용하지 않는다.
- 단일 scope 10만 행, 순차 단일 연결의 로컬 합성 fixture 실측이다. 동시 부하·운영 규모·보안 인증을 보장하지 않는다.
- 새 제품의 실제 후보 배열이 최대3임을 모든 첫 실행 SQL에서 단언했다. 이 검사는 판정 함수 전체 입력을 최대3으로 줄였다는 뜻이 아니다.


## 추가 확인: zero_and_common2 목록300

주 측정 뒤 추가 실행했다. 실제 SQL 문자열 동일: **true**, 실제 파라미터 동일: **true**. 각 경로의 SQL 문장별 EXPLAIN (ANALYZE, BUFFERS, VERBOSE)을 1회 수집하고, 예열2회 후 기존 조건과 정확히 같은 경로 순서로 7회 추가 측정했다. 원래118항목 결과는 그대로 보존했다.

| 구간 | 지표 | 평문 ms | 이전 ms | 새 ms | 차이 ms | 새/이전 |
|---|---|---:|---:|---:|---:|---:|
| 주 측정 | SQL 왕복 | 206.03 | 18.90 | 45.00 | 26.10 | 2.38× |
| 주 측정 | 전체 | 206.12 | 21.27 | 46.75 | 25.48 | 2.20× |
| 추가7회 | SQL 왕복 | 221.60 | 20.36 | 54.72 | 34.36 | 2.69× |
| 추가7회 | 전체 | 221.71 | 22.95 | 57.14 | 34.19 | 2.49× |

두 빌드가 같은 SQL·파라미터를 보냈으므로 이 조건의 최초 SQL 시간 차이는 P1 토큰 선택으로 달라진 질의의 퇴행을 보여주지 않는다. 같은 SQL의 왕복 측정 변동으로 분류하되, 추가7회에서도 격차가 재현되어 무작위 잡음으로 단정하지 않는다. EXPLAIN의 서버 실행 시간은 비슷했으며 왕복 격차의 원인은 이번 확인에서 밝혀지지 않았다. 전체 API 시간에는 서로 다른 빌드의 준비·처리 비용도 포함되므로 SQL 동일성만으로 그 비용까지 같다고 단정하지 않는다.

| 경로/SQL | 계획 루트 | 예상/실제 행 | 실행 ms | shared hit/read |
|---|---|---:|---:|---:|
| 이전 7c14bda/1 | Limit | 2/0 | 19.23 | 10009/0 |
| 새 638f9c2/1 | Limit | 2/0 | 18.60 | 10009/0 |

[추가7회·실제 SQL/파라미터·실행 계획 원문](focus-zero-and-common2.json), [재현 코드](../../../p1-verify/v-astra/focus.ts).


## 원인 확인: prepared plan과 선행 질의 캐시 효과

**결론: zero_and_common2의 20 대 55ms 차이는 P1 SQL 퇴행이 아니라 선행 평문 조회가 바꾼 shared-buffer 상태와 측정 순서의 결합이었다.** 선행 질의를 같게 통제하면 두 공개 API의 시간이 같아진다. 실제 제품 호출에서도 검색 데이터가 버퍼에서 밀려난 상황은 느려질 수 있지만, 이 조건에서는 이전·새 제품 모두 같은 영향을 받았다.

| 확인 항목 | 관찰 |
|---|---|
| 드라이버 | 두 제품 모두 같은 pg Client, config 객체 + 두 번째 values 배열 + callback; rowMode=array; name 없음; 같은 custom type parser 경로 |
| prepared statement | 초기·auto7회 후·custom7회 후·종료 모두 pg_prepared_statements가 비어 있음 |
| auto→force_custom_plan | 왕복 차이가 남음. 이름 있는 prepared statement의 generic 전환으로 설명되지 않음 |
| 동일 SQL 직접 실행 | 제품 준비 없이 같은 SQL·파라미터를 번갈아 실행하면 두 레이블의 시간은 비슷함 |

| 실행 | plan_cache_mode | 이전 SQL ms | 새 SQL ms |
|---|---|---:|---:|
| 공개 API·기존 순서 | auto | 18.69 | 45.89 |
| 동일 SQL 직접 반복 | auto | 19.04 | 19.23 |
| 공개 API·기존 순서 | force_custom_plan | 20.05 | 45.25 |
| 동일 SQL 직접 반복 | force_custom_plan | 18.09 | 18.22 |

선행 질의 통제는 force_custom_plan에서 각 조합 예열2회+추가7회로 실행했다. 아래 실제 API 시간은 앞서 수집한 SQL 재생이 아니라 해당 빌드의 공개 findMany 호출이다.

| 바로 앞 실행 | 대상 | SQL 중앙값 ms | 전체 중앙값 ms |
|---|---|---:|---:|
| 평문 | 이전 7c14bda | 45.35 | 47.29 |
| 평문 | 새 638f9c2 | 44.43 | 46.50 |
| 새 638f9c2 | 이전 7c14bda | 18.51 | 20.68 |
| 이전 7c14bda | 새 638f9c2 | 18.34 | 20.47 |

각 선행 조건 뒤 EXPLAIN ANALYZE BUFFERS도 별도로 1회씩 실행했다. shared read는 PostgreSQL 공유 버퍼로 블록을 읽었다는 뜻이며 물리 디스크 읽기 횟수로 해석하지 않는다.

| 바로 앞 실행 | 대상 | 서버 실행 ms | shared hit | shared read |
|---|---|---:|---:|---:|
| 평문 | 이전 7c14bda | 47.59 | 22 | 9987 |
| 평문 | 새 638f9c2 | 43.79 | 11 | 9998 |
| 이전 7c14bda | 이전 7c14bda | 18.00 | 10009 | 0 |
| 이전 7c14bda | 새 638f9c2 | 18.92 | 10009 | 0 |

| 계획 비교 | custom (ANALYZE 포함) | GENERIC_PLAN (추정만) |
|---|---:|---:|
| 루트 추정 행 수 | 2 | 1 |
| 루트 total cost | 26571.20 | 53847.85 |
| 서버 실행 ms | 18.14 | 측정 안 함 |

generic 계획은 파라미터 값을 모르는 추정 계획으로 저장했다. 두 계획 모두 sample·quick·fallback 및 BitmapAnd 골격을 사용하지만 추정 행 수·비용은 다르다. 실제 공개 API에서 이름 있는 prepared statement를 재사용한 증거가 없고 force_custom_plan 실측도 원래 격차를 유지하므로 generic 계획 차이는 이번 원인이 아니다.

기존 여섯 Williams 순서는 각 회 내부의 선행 쌍만 균형이다. 회 사이의 연결과 추가 일곱 번째 순서까지 포함한 연속 실행에서는 이 조건의 평문 직후 횟수가 이전2회·새4회가 되어, 새 제품의 7회 중앙값이 버퍼 재읽기 구간을 선택했다. 반복별 시간이 그 순서와 일치했고 선행 통제·BUFFERS로 확인했다. 따라서 최초 표의 이 조건 악화를 제품 변화로 해석하지 않는다. 다른118항목 수치와 평균은 원시 측정 그대로 보존하며, 전체 행렬의 선행 캐시 영향을 모두 재검증한 것은 아니다.

[드라이버 호출·auto/custom7회·직접 SQL·generic/custom 계획](plan-cache-diagnostic.json), [선행 통제7회·BUFFERS 원문](predecessor-diagnostic.json), [plan 재현 코드](../../../p1-verify/v-astra/plan-cache-diagnostic.ts), [선행 통제 코드](../../../p1-verify/v-astra/predecessor-diagnostic.ts).
