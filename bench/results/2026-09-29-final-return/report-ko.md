# compact-only 최종안 비교 측정

측정 제품 커밋: `59d4ce9e70aaffff2fca3a67baa6a4ee6c378c0a`. 조회 113/113개, 조회 완료 true, 쓰기 완료 true, 용량 완료 true.

제품은 연구 최종안 대비 SQL 기준 39개, 전체 시간 기준 32개가 1.10배/차이 1ms 허용선을 넘었다. SQL 1초 초과 1개, 전체 1초 초과 2개다. 정확성 검증은 통과했으나 성능 목표는 미달이다.

| 종류 | 완료 | SQL 미달 | 전체 미달 | SQL >1초 | 전체 >1초 |
| --- | --- | --- | --- | --- | --- |
| count | 55 | 9 | 13 | 1 | 1 |
| list300 | 55 | 30 | 19 | 0 | 0 |
| listAll | 3 | 0 | 0 | 0 | 1 |

## 조건과 검증

원본 fixture 100000행의 `*_plain`을 공개 `sealed.insert`로 새 제품 스키마에 적재했다. 공백·대소문자를 보존하며 회사명 exact bits=2, 나머지 기본값, substring=true, wordBoundary 없음이다. 연구 기준선은 task4의 평문 정규화·색인·`pb_4_final` 도장/후보 형식을 재구축했다. 보호 표는 읽기만 했다.

동일 PostgreSQL 연결(pid 27888), 예열 2회 후 순서를 회전한 7회 중앙값이다. 첫 호출은 별도로 보존했고 OS 캐시는 비우지 않았다. 모든 실행에서 독립 원문 정규화 oracle과 count 또는 정렬 ID·6필드를 비교했다. SQL 요청~응답은 클라이언트 왕복 합계이며 서버 시간만이 아니다. pre/between/post/total은 벽시계 구간이고 지표별 중앙값은 합산되지 않을 수 있다.

task4 52조건의 count·목록300, 전체목록 3개, LIKE 3조건의 count·목록300으로 113개다. LIKE 기준선은 역사적 startsWith/endsWith/contains와 정확히 동치인 패턴만 썼다. 모든 literal은 2글자 이상이다. 원래 조건의 respectWords 표시는 task4와 같이 적용하지 않았다.

연구 후보 생성은 당시 word/skip 토큰 형식을 독립적으로 고정했으며 1200필드 native 후보 확인, 198개 동기/WebCrypto 벡터 일치, 기준선 52조건 검증을 통과했다. 연구 목록은 기존 암호 본문을 사용한다. 연구 쓰기는 당시 정규화 평문 암호화를 유지하고 제품 쓰기는 원문 왕복까지 확인한다.

DB 내부 후보 수는 계측하지 않았다. 아래 DB 반환 행은 드라이버가 받은 행이며 내부 후보 수와 다르다. count의 DB 반환은 1행, 인증 복호화는 0회다. 목록은 선택한 6필드의 실제 Sealer.open 호출을 계측했다. C 로캘 한글 LIKE는 평문 전체 스캔 영향을 받아 †로 표시하며 평문 대비 성능 주장에 쓰지 않는다. 배율은 연구 최종안 대비다.

최종 실행은 변형 없는 3경로만 측정했다. 제품 원문 적재는 527d13fab5b1d62a67d0b710687a461b1b2b1ce5, 조회 함수는 보고서 맨 위 최종 커밋으로 재설치하고 ANALYZE했다. 이전 변형 부분 측정은 [별도 보고](report-variants-partial-ko.md)에 보존했다. 인터셉터의 rowMode와 별도 values 인자 보존 회귀 시험 1/1이 통과했다.

## 조회 SQL 요청~응답

단위 ms, 배율=제품/연구. 근거: [measure.json](measure.json), [cases.json](cases.json).

| 조건 | 종류 | 일치/반환 | 평문 | 연구 최종안 | 새 제품 | 배율 | 판정 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| coarse_company_zero | count | 0/1 | 0.51 | 86.15 | 28.04 | 0.33× | 통과 |
| coarse_company_zero | list300 | 0/0 | 0.63 | 310.15 | 36.00 | 0.12× | 통과 |
| coarse_rare_and_memo † | count | 1325/1 | 1.98 | 36.74 | 33.62 | 0.92× | 통과 |
| coarse_rare_and_memo † | list300 | 1325/300 | 3.38 | 32.61 | 26.77 | 0.82× | 통과 |
| coarse_zero_and_memo † | count | 0/1 | 0.64 | 95.86 | 32.23 | 0.34× | 통과 |
| coarse_zero_and_memo † | list300 | 0/0 | 0.49 | 230.60 | 45.79 | 0.20× | 통과 |
| exact_common | count | 28331/1 | 7.73 | 83.45 | 57.39 | 0.69× | 통과 |
| exact_common | list300 | 28331/300 | 1.27 | 3.95 | 5.04 | 1.28× | 미달 |
| sub_common_memo † | count | 40097/1 | 19.60 | 363.29 | 189.07 | 0.52× | 통과 |
| sub_common_memo † | list300 | 40097/300 | 1.25 | 93.10 | 8.52 | 0.09× | 통과 |
| sub_mid † | count | 16574/1 | 18.50 | 154.01 | 177.26 | 1.15× | 미달 |
| sub_mid † | list300 | 16574/300 | 1.42 | 58.48 | 68.51 | 1.17× | 미달 |
| sub_rare † | count | 101/1 | 18.88 | 1.57 | 1.60 | 1.02× | 통과 |
| sub_rare † | list300 | 101/101 | 18.99 | 2.86 | 5.24 | 1.83× | 미달 |
| starts † | count | 16574/1 | 6.99 | 102.47 | 94.02 | 0.92× | 통과 |
| starts † | list300 | 16574/300 | 1.47 | 57.08 | 73.22 | 1.28× | 미달 |
| ends | count | 26598/1 | 17.97 | 584.44 | 474.48 | 0.81× | 통과 |
| ends | list300 | 26598/300 | 1.27 | 91.63 | 12.38 | 0.14× | 통과 |
| and2 † | count | 21176/1 | 10.47 | 266.66 | 165.16 | 0.62× | 통과 |
| and2 † | list300 | 21176/300 | 1.55 | 88.79 | 125.77 | 1.42× | 미달 |
| and4 † | count | 62/1 | 6.99 | 7.83 | 8.27 | 1.06× | 통과 |
| and4 † | list300 | 62/62 | 7.34 | 9.92 | 13.51 | 1.36× | 미달 |
| and6 † | count | 624/1 | 7.55 | 27.91 | 28.40 | 1.02× | 통과 |
| and6 † | list300 | 624/300 | 8.90 | 22.95 | 26.88 | 1.17× | 미달 |
| or2 † | count | 28400/1 | 19.88 | 139.40 | 131.82 | 0.95× | 통과 |
| or2 † | list300 | 28400/300 | 1.36 | 6.10 | 6.28 | 1.03× | 통과 |
| or3 | count | 2/1 | 0.48 | 0.54 | 0.76 | 1.39× | 차이 ≤1ms |
| or3 | list300 | 2/2 | 0.52 | 1.15 | 4.11 | 3.57× | 미달 |
| or_and_mix † | count | 21277/1 | 23.11 | 379.17 | 170.29 | 0.45× | 통과 |
| or_and_mix † | list300 | 21277/300 | 1.56 | 90.95 | 127.49 | 1.40× | 미달 |
| word_boundary † | count | 29843/1 | 20.53 | 369.16 | 407.54 | 1.10× | 미달 |
| word_boundary † | list300 | 29843/300 | 1.29 | 94.52 | 11.15 | 0.12× | 통과 |
| sub45 † | count | 0/1 | 23.37 | 34.05 | 18.10 | 0.53× | 통과 |
| sub45 † | list300 | 0/0 | 21.72 | 47.81 | 26.81 | 0.56× | 통과 |
| zero_and_common2 † | count | 0/1 | 10.04 | 6.55 | 27.03 | 4.12× | 미달 |
| zero_and_common2 † | list300 | 0/0 | 24.56 | 27.26 | 18.67 | 0.68× | 통과 |
| zero_and_common3 † | count | 0/1 | 10.07 | 6.21 | 6.07 | 0.98× | 통과 |
| zero_and_common3 † | list300 | 0/0 | 25.97 | 7.55 | 15.33 | 2.03× | 미달 |
| zero_fragment † | count | 0/1 | 21.86 | 0.67 | 0.67 | 1.00× | 통과 |
| zero_fragment † | list300 | 0/0 | 21.32 | 0.95 | 3.40 | 3.59× | 미달 |
| zero_fragment_long † | count | 0/1 | 22.03 | 0.79 | 0.76 | 0.96× | 통과 |
| zero_fragment_long † | list300 | 0/0 | 21.29 | 0.98 | 3.33 | 3.38× | 미달 |
| zero_or_all † | count | 0/1 | 35.68 | 0.70 | 0.74 | 1.06× | 통과 |
| zero_or_all † | list300 | 0/0 | 35.60 | 1.04 | 5.78 | 5.56× | 미달 |
| exact_zero | count | 0/1 | 0.19 | 0.26 | 0.28 | 1.08× | 통과 |
| exact_zero | list300 | 0/0 | 0.36 | 0.57 | 2.40 | 4.18× | 미달 |
| sub_zero † | count | 0/1 | 21.10 | 0.62 | 0.51 | 0.83× | 통과 |
| sub_zero † | list300 | 0/0 | 20.71 | 0.79 | 3.22 | 4.07× | 미달 |
| or4 † | count | 28401/1 | 24.83 | 142.33 | 125.24 | 0.88× | 통과 |
| or4 † | list300 | 28401/300 | 1.33 | 7.28 | 7.55 | 1.04× | 통과 |
| or5 † | count | 40276/1 | 34.96 | 229.91 | 174.83 | 0.76× | 통과 |
| or5 † | list300 | 40276/300 | 1.43 | 9.29 | 7.95 | 0.86× | 통과 |
| or6 † | count | 59768/1 | 37.77 | 425.43 | 311.11 | 0.73× | 통과 |
| or6 † | list300 | 59768/300 | 1.30 | 10.37 | 8.54 | 0.82× | 통과 |
| and2_or_and2 † | count | 22846/1 | 23.21 | 208.52 | 179.53 | 0.86× | 통과 |
| and2_or_and2 † | list300 | 22846/300 | 1.87 | 115.03 | 15.18 | 0.13× | 통과 |
| or2_and_or2 † | count | 7373/1 | 25.87 | 155.80 | 116.47 | 0.75× | 통과 |
| or2_and_or2 † | list300 | 7373/300 | 2.36 | 59.95 | 17.88 | 0.30× | 통과 |
| and3_or_rare † | count | 3629/1 | 26.81 | 108.57 | 87.01 | 0.80× | 통과 |
| and3_or_rare † | list300 | 3629/300 | 3.52 | 23.77 | 32.10 | 1.35× | 미달 |
| nested3 † | count | 23177/1 | 31.98 | 262.81 | 238.60 | 0.91× | 통과 |
| nested3 † | list300 | 23177/300 | 1.66 | 118.02 | 17.74 | 0.15× | 통과 |
| exact_mid | count | 1770/1 | 2.03 | 78.41 | 29.82 | 0.38× | 통과 |
| exact_mid | list300 | 1770/300 | 4.09 | 22.34 | 8.77 | 0.39× | 통과 |
| exact_one | count | 1/1 | 0.31 | 0.31 | 0.41 | 1.32× | 차이 ≤1ms |
| exact_one | list300 | 1/1 | 0.28 | 0.49 | 2.11 | 4.34× | 미달 |
| sub2_common † | count | 30101/1 | 17.14 | 101.43 | 116.39 | 1.15× | 미달 |
| sub2_common † | list300 | 30101/300 | 1.15 | 5.66 | 5.74 | 1.02× | 통과 |
| sub_mid_space † | count | 213/1 | 1.08 | 3.78 | 4.22 | 1.12× | 차이 ≤1ms |
| sub_mid_space † | list300 | 213/213 | 24.64 | 6.93 | 8.77 | 1.27× | 미달 |
| sub_long † | count | 2440/1 | 23.89 | 115.21 | 93.26 | 0.81× | 통과 |
| sub_long † | list300 | 2440/300 | 5.14 | 27.29 | 24.84 | 0.91× | 통과 |
| word_inside_longer † | count | 29843/1 | 21.15 | 345.58 | 170.13 | 0.49× | 통과 |
| word_inside_longer † | list300 | 29843/300 | 1.51 | 103.76 | 10.34 | 0.10× | 통과 |
| space_memo † | count | 29843/1 | 20.85 | 405.38 | 419.79 | 1.04× | 통과 |
| space_memo † | list300 | 29843/300 | 1.30 | 92.54 | 11.02 | 0.12× | 통과 |
| space_address † | count | 213/1 | 1.19 | 3.82 | 4.29 | 1.12× | 차이 ≤1ms |
| space_address † | list300 | 213/213 | 24.50 | 7.04 | 8.65 | 1.23× | 미달 |
| space_inside † | count | 29843/1 | 17.45 | 283.04 | 155.04 | 0.55× | 통과 |
| space_inside † | list300 | 29843/300 | 1.21 | 86.69 | 9.79 | 0.11× | 통과 |
| affix_startsWith_name † | count | 28023/1 | 10.88 | 240.65 | 285.73 | 1.19× | 미달 |
| affix_startsWith_name † | list300 | 28023/300 | 1.31 | 79.06 | 10.18 | 0.13× | 통과 |
| affix_endsWith_name | count | 6/1 | 0.23 | 0.41 | 0.49 | 1.19× | 차이 ≤1ms |
| affix_endsWith_name | list300 | 6/6 | 0.37 | 0.80 | 3.15 | 3.93× | 미달 |
| affix_startsWith_phone | count | 1251/1 | 1.43 | 12.84 | 14.33 | 1.12× | 미달 |
| affix_startsWith_phone | list300 | 1251/300 | 2.66 | 9.00 | 11.86 | 1.32× | 미달 |
| affix_endsWith_phone | count | 110/1 | 0.51 | 2.07 | 2.34 | 1.13× | 차이 ≤1ms |
| affix_endsWith_phone | list300 | 110/110 | 1.25 | 3.62 | 6.61 | 1.82× | 미달 |
| affix_startsWith_address † | count | 16526/1 | 7.20 | 152.01 | 177.81 | 1.17× | 미달 |
| affix_startsWith_address † | list300 | 16526/300 | 1.47 | 57.32 | 66.87 | 1.17× | 미달 |
| affix_endsWith_address † | count | 10038/1 | 17.42 | 103.99 | 111.43 | 1.07× | 통과 |
| affix_endsWith_address † | list300 | 10038/300 | 1.62 | 36.99 | 58.33 | 1.58× | 미달 |
| affix_startsWith_memo † | count | 101/1 | 0.35 | 1.27 | 1.39 | 1.09× | 통과 |
| affix_startsWith_memo † | list300 | 101/101 | 0.91 | 2.78 | 5.50 | 1.98× | 미달 |
| affix_endsWith_memo | count | 6/1 | 0.24 | 0.42 | 0.45 | 1.06× | 통과 |
| affix_endsWith_memo | list300 | 6/6 | 0.42 | 0.94 | 3.50 | 3.73× | 미달 |
| affix_startsWith_email | count | 6/1 | 0.24 | 0.64 | 0.74 | 1.15× | 차이 ≤1ms |
| affix_startsWith_email | list300 | 6/6 | 0.38 | 1.06 | 3.80 | 3.58× | 미달 |
| affix_endsWith_email | count | 100000/1 | 23.09 | 531.59 | 350.02 | 0.66× | 통과 |
| affix_endsWith_email | list300 | 100000/300 | 1.19 | 7.75 | 6.24 | 0.81× | 통과 |
| affix_startsWith_company † | count | 30101/1 | 9.69 | 257.98 | 298.44 | 1.16× | 미달 |
| affix_startsWith_company † | list300 | 30101/300 | 1.17 | 82.63 | 9.74 | 0.12× | 통과 |
| affix_endsWith_company † | count | 5883/1 | 34.97 | 50.27 | 55.01 | 1.09× | 통과 |
| affix_endsWith_company † | list300 | 5883/300 | 2.12 | 19.08 | 16.97 | 0.89× | 통과 |
| like_prefix2plus | count | 6/1 | 0.22 | 0.67 | 1.07 | 1.60× | 차이 ≤1ms |
| like_prefix2plus | list300 | 6/6 | 0.41 | 1.16 | 4.04 | 3.49× | 미달 |
| like_suffix2plus | count | 100000/1 | 23.80 | 534.49 | 1233.05 | 2.31× | 미달 |
| like_suffix2plus | list300 | 100000/300 | 1.25 | 7.84 | 14.04 | 1.79× | 미달 |
| like_contains2plus | count | 9/1 | 0.24 | 0.58 | 1.15 | 1.97× | 차이 ≤1ms |
| like_contains2plus | list300 | 9/9 | 0.47 | 1.11 | 4.18 | 3.79× | 미달 |
| exact_common | listAll | 28331/28331 | 61.14 | 480.67 | 161.45 | 0.34× | 통과 |
| sub_rare † | listAll | 101/101 | 18.66 | 2.66 | 2.68 | 1.01× | 통과 |
| exact_one | listAll | 1/1 | 0.25 | 0.49 | 0.56 | 1.15× | 차이 ≤1ms |

## 조회 전체 시간

단위 ms. 근거: [measure.json](measure.json).

| 조건 | 종류 | 평문 | 연구 최종안 | 새 제품 | 배율 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| coarse_company_zero | count | 0.57 | 86.58 | 28.99 | 0.33× | 통과 |
| coarse_company_zero | list300 | 0.68 | 310.59 | 37.61 | 0.12× | 통과 |
| coarse_rare_and_memo | count | 2.04 | 37.34 | 34.75 | 0.93× | 통과 |
| coarse_rare_and_memo | list300 | 3.50 | 102.18 | 90.78 | 0.89× | 통과 |
| coarse_zero_and_memo | count | 0.72 | 96.46 | 33.56 | 0.35× | 통과 |
| coarse_zero_and_memo | list300 | 0.54 | 231.18 | 48.16 | 0.21× | 통과 |
| exact_common | count | 7.80 | 83.76 | 58.21 | 0.69× | 통과 |
| exact_common | list300 | 1.33 | 73.32 | 66.03 | 0.90× | 통과 |
| sub_common_memo | count | 19.67 | 363.74 | 189.96 | 0.52× | 통과 |
| sub_common_memo | list300 | 1.32 | 157.45 | 68.46 | 0.43× | 통과 |
| sub_mid | count | 18.57 | 154.46 | 178.28 | 1.15× | 미달 |
| sub_mid | list300 | 1.50 | 123.93 | 132.35 | 1.07× | 통과 |
| sub_rare | count | 18.95 | 1.97 | 2.44 | 1.24× | 차이 ≤1ms |
| sub_rare | list300 | 19.06 | 25.12 | 27.46 | 1.09× | 통과 |
| starts | count | 7.04 | 102.86 | 95.03 | 0.92× | 통과 |
| starts | list300 | 1.52 | 126.05 | 141.05 | 1.12× | 미달 |
| ends | count | 18.04 | 585.08 | 476.68 | 0.81× | 통과 |
| ends | list300 | 1.34 | 160.92 | 72.06 | 0.45× | 통과 |
| and2 | count | 10.56 | 267.74 | 166.39 | 0.62× | 통과 |
| and2 | list300 | 1.64 | 155.51 | 192.06 | 1.24× | 미달 |
| and4 | count | 7.07 | 8.98 | 10.34 | 1.15× | 미달 |
| and4 | list300 | 7.40 | 23.70 | 28.93 | 1.22× | 미달 |
| and6 | count | 7.63 | 29.22 | 30.76 | 1.05× | 통과 |
| and6 | list300 | 8.98 | 93.27 | 92.65 | 0.99× | 통과 |
| or2 | count | 19.96 | 139.97 | 132.88 | 0.95× | 통과 |
| or2 | list300 | 1.42 | 75.97 | 69.45 | 0.91× | 통과 |
| or3 | count | 0.51 | 1.17 | 2.16 | 1.84× | 차이 ≤1ms |
| or3 | list300 | 0.56 | 2.56 | 6.97 | 2.72× | 미달 |
| or_and_mix | count | 23.19 | 379.88 | 171.77 | 0.45× | 통과 |
| or_and_mix | list300 | 1.62 | 160.18 | 195.71 | 1.22× | 미달 |
| word_boundary | count | 20.60 | 369.65 | 408.58 | 1.11× | 미달 |
| word_boundary | list300 | 1.34 | 159.27 | 76.01 | 0.48× | 통과 |
| sub45 | count | 23.44 | 35.63 | 21.01 | 0.59× | 통과 |
| sub45 | list300 | 21.79 | 49.19 | 29.78 | 0.61× | 통과 |
| zero_and_common2 | count | 10.11 | 7.17 | 28.00 | 3.91× | 미달 |
| zero_and_common2 | list300 | 24.63 | 27.81 | 20.57 | 0.74× | 통과 |
| zero_and_common3 | count | 10.15 | 7.08 | 7.58 | 1.07× | 통과 |
| zero_and_common3 | list300 | 26.05 | 8.42 | 18.10 | 2.15× | 미달 |
| zero_fragment | count | 21.93 | 1.17 | 1.65 | 1.40× | 차이 ≤1ms |
| zero_fragment | list300 | 21.40 | 1.55 | 5.19 | 3.35× | 미달 |
| zero_fragment_long | count | 22.10 | 1.48 | 2.22 | 1.50× | 차이 ≤1ms |
| zero_fragment_long | list300 | 21.34 | 1.64 | 5.53 | 3.38× | 미달 |
| zero_or_all | count | 35.76 | 1.63 | 2.39 | 1.46× | 차이 ≤1ms |
| zero_or_all | list300 | 35.68 | 1.99 | 8.75 | 4.40× | 미달 |
| exact_zero | count | 0.21 | 0.41 | 0.72 | 1.77× | 차이 ≤1ms |
| exact_zero | list300 | 0.40 | 0.82 | 3.52 | 4.27× | 미달 |
| sub_zero | count | 21.17 | 1.16 | 1.48 | 1.28× | 차이 ≤1ms |
| sub_zero | list300 | 20.77 | 1.36 | 4.88 | 3.59× | 미달 |
| or4 | count | 24.90 | 143.56 | 126.87 | 0.88× | 통과 |
| or4 | list300 | 1.39 | 74.62 | 71.34 | 0.96× | 통과 |
| or5 | count | 35.03 | 231.05 | 176.93 | 0.77× | 통과 |
| or5 | list300 | 1.49 | 76.01 | 73.51 | 0.97× | 통과 |
| or6 | count | 37.88 | 427.45 | 314.02 | 0.73× | 통과 |
| or6 | list300 | 1.37 | 79.26 | 74.64 | 0.94× | 통과 |
| and2_or_and2 | count | 23.29 | 209.88 | 181.18 | 0.86× | 통과 |
| and2_or_and2 | list300 | 1.95 | 197.83 | 96.66 | 0.49× | 통과 |
| or2_and_or2 | count | 25.94 | 157.38 | 118.66 | 0.75× | 통과 |
| or2_and_or2 | list300 | 2.42 | 139.64 | 98.08 | 0.70× | 통과 |
| and3_or_rare | count | 26.91 | 109.98 | 88.93 | 0.81× | 통과 |
| and3_or_rare | list300 | 3.60 | 92.20 | 100.73 | 1.09× | 통과 |
| nested3 | count | 32.06 | 263.99 | 241.08 | 0.91× | 통과 |
| nested3 | list300 | 1.72 | 185.72 | 83.30 | 0.45× | 통과 |
| exact_mid | count | 2.09 | 78.77 | 30.65 | 0.39× | 통과 |
| exact_mid | list300 | 4.14 | 88.00 | 71.56 | 0.81× | 통과 |
| exact_one | count | 0.33 | 0.65 | 1.20 | 1.84× | 차이 ≤1ms |
| exact_one | list300 | 0.30 | 0.94 | 3.48 | 3.70× | 미달 |
| sub2_common | count | 17.21 | 101.77 | 117.12 | 1.15× | 미달 |
| sub2_common | list300 | 1.21 | 68.74 | 65.93 | 0.96× | 통과 |
| sub_mid_space | count | 1.10 | 4.27 | 5.21 | 1.22× | 차이 ≤1ms |
| sub_mid_space | list300 | 24.70 | 54.78 | 53.93 | 0.98× | 통과 |
| sub_long | count | 23.97 | 116.09 | 94.89 | 0.82× | 통과 |
| sub_long | list300 | 5.21 | 116.61 | 107.28 | 0.92× | 통과 |
| word_inside_longer | count | 21.21 | 346.03 | 171.10 | 0.49× | 통과 |
| word_inside_longer | list300 | 1.58 | 188.60 | 91.10 | 0.48× | 통과 |
| space_memo | count | 20.92 | 405.93 | 420.98 | 1.04× | 통과 |
| space_memo | list300 | 1.35 | 157.92 | 72.96 | 0.46× | 통과 |
| space_address | count | 1.22 | 4.29 | 5.37 | 1.25× | 미달 |
| space_address | list300 | 24.57 | 52.81 | 52.74 | 1.00× | 통과 |
| space_inside | count | 17.51 | 283.58 | 155.87 | 0.55× | 통과 |
| space_inside | list300 | 1.26 | 153.95 | 72.70 | 0.47× | 통과 |
| affix_startsWith_name | count | 10.95 | 241.06 | 286.63 | 1.19× | 미달 |
| affix_startsWith_name | list300 | 1.36 | 144.49 | 72.30 | 0.50× | 통과 |
| affix_endsWith_name | count | 0.24 | 0.66 | 1.19 | 1.80× | 차이 ≤1ms |
| affix_endsWith_name | list300 | 0.41 | 2.49 | 5.80 | 2.33× | 미달 |
| affix_startsWith_phone | count | 1.47 | 13.24 | 15.27 | 1.15× | 미달 |
| affix_startsWith_phone | list300 | 2.72 | 77.09 | 77.60 | 1.01× | 통과 |
| affix_endsWith_phone | count | 0.53 | 2.36 | 3.01 | 1.28× | 차이 ≤1ms |
| affix_endsWith_phone | list300 | 1.30 | 29.16 | 30.35 | 1.04× | 통과 |
| affix_startsWith_address | count | 7.27 | 152.45 | 179.08 | 1.17× | 미달 |
| affix_startsWith_address | list300 | 1.53 | 125.57 | 132.98 | 1.06× | 통과 |
| affix_endsWith_address | count | 17.48 | 104.56 | 112.36 | 1.07× | 통과 |
| affix_endsWith_address | list300 | 1.68 | 101.50 | 121.34 | 1.20× | 미달 |
| affix_startsWith_memo | count | 0.36 | 1.59 | 2.26 | 1.43× | 차이 ≤1ms |
| affix_startsWith_memo | list300 | 0.95 | 24.30 | 29.05 | 1.20× | 미달 |
| affix_endsWith_memo | count | 0.25 | 0.69 | 1.05 | 1.53× | 차이 ≤1ms |
| affix_endsWith_memo | list300 | 0.44 | 2.51 | 6.17 | 2.45× | 미달 |
| affix_startsWith_email | count | 0.26 | 0.89 | 1.33 | 1.49× | 차이 ≤1ms |
| affix_startsWith_email | list300 | 0.40 | 2.69 | 6.44 | 2.39× | 미달 |
| affix_endsWith_email | count | 23.15 | 532.02 | 351.00 | 0.66× | 통과 |
| affix_endsWith_email | list300 | 1.26 | 79.70 | 67.52 | 0.85× | 통과 |
| affix_startsWith_company | count | 9.75 | 258.40 | 299.34 | 1.16× | 미달 |
| affix_startsWith_company | list300 | 1.22 | 149.76 | 80.50 | 0.54× | 통과 |
| affix_endsWith_company | count | 35.03 | 50.67 | 55.94 | 1.10× | 미달 |
| affix_endsWith_company | list300 | 2.19 | 87.19 | 82.56 | 0.95× | 통과 |
| like_prefix2plus | count | 0.24 | 0.91 | 1.77 | 1.94× | 차이 ≤1ms |
| like_prefix2plus | list300 | 0.44 | 2.96 | 6.71 | 2.27× | 미달 |
| like_suffix2plus | count | 23.86 | 534.92 | 1233.95 | 2.31× | 미달 |
| like_suffix2plus | list300 | 1.33 | 77.11 | 79.37 | 1.03× | 통과 |
| like_contains2plus | count | 0.26 | 0.84 | 1.91 | 2.27× | 미달 |
| like_contains2plus | list300 | 0.51 | 3.31 | 7.41 | 2.24× | 미달 |
| exact_common | listAll | 61.25 | 6972.71 | 5820.44 | 0.83× | 통과 |
| sub_rare | listAll | 18.72 | 23.92 | 23.73 | 0.99× | 통과 |
| exact_one | listAll | 0.27 | 0.92 | 1.52 | 1.66× | 차이 ≤1ms |

## 제품 호출 분해와 첫 측정

단위 ms. 최초 값은 cold cache 주장이 아니다. 후보 수는 미계측. 근거: [measure.json](measure.json).

| 조건/종류 | 첫 SQL/전체 | pre | between | post | SQL 횟수 | DB 반환/결과 행 | 인증 복호화 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| coarse_company_zero/count | 30.56/36.43 | 0.92 | 0.00 | 0.07 | 1 | 1/1 | 0 |
| coarse_company_zero/list300 | 36.83/41.75 | 1.61 | 0.00 | 0.07 | 1 | 0/0 | 0 |
| coarse_rare_and_memo/count | 45.67/47.66 | 1.08 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| coarse_rare_and_memo/list300 | 32.73/112.78 | 2.34 | 0.00 | 62.30 | 1 | 300/300 | 1800 |
| coarse_zero_and_memo/count | 33.65/34.88 | 1.24 | 0.00 | 0.06 | 1 | 1/1 | 0 |
| coarse_zero_and_memo/list300 | 52.74/54.91 | 2.20 | 0.00 | 0.06 | 1 | 0/0 | 0 |
| exact_common/count | 65.42/66.32 | 0.63 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| exact_common/list300 | 5.39/74.37 | 1.52 | 0.00 | 59.29 | 1 | 300/300 | 1800 |
| sub_common_memo/count | 231.31/232.20 | 0.89 | 0.00 | 0.06 | 1 | 1/1 | 0 |
| sub_common_memo/list300 | 9.91/93.90 | 1.53 | 0.00 | 56.79 | 1 | 300/300 | 1800 |
| sub_mid/count | 180.46/186.61 | 0.97 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| sub_mid/list300 | 66.87/153.80 | 1.80 | 0.00 | 61.32 | 1 | 300/300 | 1800 |
| sub_rare/count | 2.17/3.35 | 0.82 | 0.00 | 0.02 | 1 | 1/1 | 0 |
| sub_rare/list300 | 9.51/31.58 | 1.59 | 0.00 | 20.13 | 1 | 101/101 | 606 |
| starts/count | 92.25/93.09 | 0.96 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| starts/list300 | 78.96/148.94 | 1.55 | 0.00 | 62.39 | 1 | 300/300 | 1800 |
| ends/count | 458.65/460.65 | 1.59 | 0.00 | 0.06 | 1 | 1/1 | 0 |
| ends/list300 | 14.77/86.71 | 2.03 | 0.00 | 57.25 | 1 | 300/300 | 1800 |
| and2/count | 161.87/163.20 | 1.17 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| and2/list300 | 129.04/192.48 | 2.17 | 0.00 | 61.13 | 1 | 300/300 | 1800 |
| and4/count | 10.04/12.07 | 2.00 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| and4/list300 | 17.14/35.64 | 3.43 | 0.00 | 11.74 | 1 | 62/62 | 372 |
| and6/count | 31.12/34.03 | 2.31 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| and6/list300 | 30.15/93.78 | 4.08 | 0.00 | 61.46 | 1 | 300/300 | 1800 |
| or2/count | 121.31/122.43 | 1.22 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| or2/list300 | 10.04/90.57 | 2.17 | 0.00 | 61.07 | 1 | 300/300 | 1800 |
| or3/count | 0.77/2.25 | 1.33 | 0.00 | 0.02 | 1 | 1/1 | 0 |
| or3/list300 | 4.69/7.85 | 2.34 | 0.00 | 0.58 | 1 | 2/2 | 12 |
| or_and_mix/count | 171.03/172.68 | 1.43 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| or_and_mix/list300 | 130.59/200.73 | 3.39 | 0.00 | 58.36 | 1 | 300/300 | 1800 |
| word_boundary/count | 400.24/401.28 | 1.01 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| word_boundary/list300 | 11.07/92.42 | 5.03 | 0.00 | 58.84 | 1 | 300/300 | 1800 |
| sub45/count | 26.09/28.33 | 2.65 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| sub45/list300 | 27.86/30.69 | 2.94 | 0.00 | 0.06 | 1 | 0/0 | 0 |
| zero_and_common2/count | 37.58/39.26 | 0.95 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| zero_and_common2/list300 | 42.29/44.30 | 1.94 | 0.00 | 0.05 | 1 | 0/0 | 0 |
| zero_and_common3/count | 6.39/7.82 | 1.37 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| zero_and_common3/list300 | 14.40/17.14 | 2.71 | 0.00 | 0.06 | 1 | 0/0 | 0 |
| zero_fragment/count | 0.56/1.57 | 0.96 | 0.00 | 0.02 | 1 | 1/1 | 0 |
| zero_fragment/list300 | 3.53/5.33 | 1.75 | 0.00 | 0.05 | 1 | 0/0 | 0 |
| zero_fragment_long/count | 1.00/2.80 | 1.38 | 0.00 | 0.02 | 1 | 1/1 | 0 |
| zero_fragment_long/list300 | 3.09/5.25 | 2.18 | 0.00 | 0.04 | 1 | 0/0 | 0 |
| zero_or_all/count | 1.08/2.90 | 1.64 | 0.00 | 0.02 | 1 | 1/1 | 0 |
| zero_or_all/list300 | 5.26/8.08 | 2.84 | 0.00 | 0.05 | 1 | 0/0 | 0 |
| exact_zero/count | 0.39/0.86 | 0.43 | 0.00 | 0.01 | 1 | 1/1 | 0 |
| exact_zero/list300 | 2.42/3.55 | 1.06 | 0.00 | 0.03 | 1 | 0/0 | 0 |
| sub_zero/count | 0.82/1.65 | 0.88 | 0.00 | 0.01 | 1 | 1/1 | 0 |
| sub_zero/list300 | 3.32/4.86 | 1.46 | 0.00 | 0.04 | 1 | 0/0 | 0 |
| or4/count | 128.07/129.75 | 1.65 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| or4/list300 | 9.61/70.81 | 3.95 | 0.00 | 57.26 | 1 | 300/300 | 1800 |
| or5/count | 173.05/175.63 | 2.09 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| or5/list300 | 9.85/77.35 | 4.04 | 0.00 | 58.89 | 1 | 300/300 | 1800 |
| or6/count | 306.44/309.67 | 2.87 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| or6/list300 | 10.14/78.21 | 4.80 | 0.00 | 58.31 | 1 | 300/300 | 1800 |
| and2_or_and2/count | 174.37/176.01 | 1.60 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| and2_or_and2/list300 | 16.71/109.30 | 3.85 | 0.00 | 78.71 | 1 | 300/300 | 1800 |
| or2_and_or2/count | 123.64/125.90 | 2.14 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| or2_and_or2/list300 | 29.87/125.15 | 4.22 | 0.00 | 76.91 | 1 | 300/300 | 1800 |
| and3_or_rare/count | 99.60/101.54 | 1.81 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| and3_or_rare/list300 | 57.28/127.51 | 4.41 | 0.00 | 63.42 | 1 | 300/300 | 1800 |
| nested3/count | 241.09/243.59 | 2.41 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| nested3/list300 | 19.39/95.53 | 4.56 | 0.00 | 58.59 | 1 | 300/300 | 1800 |
| exact_mid/count | 29.16/29.95 | 0.78 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| exact_mid/list300 | 14.73/82.59 | 1.34 | 0.00 | 61.16 | 1 | 300/300 | 1800 |
| exact_one/count | 0.46/1.28 | 0.78 | 0.00 | 0.01 | 1 | 1/1 | 0 |
| exact_one/list300 | 3.36/5.55 | 1.08 | 0.00 | 0.39 | 1 | 1/1 | 6 |
| sub2_common/count | 114.44/115.29 | 0.72 | 0.00 | 0.04 | 1 | 1/1 | 0 |
| sub2_common/list300 | 8.81/71.67 | 1.62 | 0.00 | 58.44 | 1 | 300/300 | 1800 |
| sub_mid_space/count | 5.26/6.25 | 0.96 | 0.00 | 0.03 | 1 | 1/1 | 0 |
| sub_mid_space/list300 | 12.39/58.45 | 2.16 | 0.00 | 42.66 | 1 | 213/213 | 1278 |
| sub_long/count | 83.82/85.34 | 1.92 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| sub_long/list300 | 29.35/126.94 | 2.79 | 0.00 | 81.42 | 1 | 300/300 | 1800 |
| word_inside_longer/count | 168.01/169.12 | 0.93 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| word_inside_longer/list300 | 11.93/103.65 | 2.15 | 0.00 | 75.85 | 1 | 300/300 | 1800 |
| space_memo/count | 519.33/520.81 | 1.14 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| space_memo/list300 | 11.61/88.54 | 5.40 | 0.00 | 56.24 | 1 | 300/300 | 1800 |
| space_address/count | 6.41/7.70 | 1.10 | 0.00 | 0.03 | 1 | 1/1 | 0 |
| space_address/list300 | 12.35/60.68 | 1.92 | 0.00 | 42.28 | 1 | 213/213 | 1278 |
| space_inside/count | 158.52/159.39 | 0.79 | 0.00 | 0.04 | 1 | 1/1 | 0 |
| space_inside/list300 | 10.40/82.48 | 1.99 | 0.00 | 59.11 | 1 | 300/300 | 1800 |
| affix_startsWith_name/count | 288.61/289.53 | 0.81 | 0.00 | 0.04 | 1 | 1/1 | 0 |
| affix_startsWith_name/list300 | 10.99/91.26 | 5.00 | 0.00 | 58.19 | 1 | 300/300 | 1800 |
| affix_endsWith_name/count | 0.98/1.91 | 0.64 | 0.00 | 0.01 | 1 | 1/1 | 0 |
| affix_endsWith_name/list300 | 4.16/6.95 | 1.43 | 0.00 | 1.14 | 1 | 6/6 | 36 |
| affix_startsWith_phone/count | 17.36/18.25 | 0.84 | 0.00 | 0.04 | 1 | 1/1 | 0 |
| affix_startsWith_phone/list300 | 15.47/80.50 | 1.87 | 0.00 | 59.12 | 1 | 300/300 | 1800 |
| affix_endsWith_phone/count | 3.71/4.99 | 0.70 | 0.00 | 0.02 | 1 | 1/1 | 0 |
| affix_endsWith_phone/list300 | 7.54/31.06 | 1.79 | 0.00 | 21.93 | 1 | 110/110 | 660 |
| affix_startsWith_address/count | 172.45/173.35 | 1.02 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| affix_startsWith_address/list300 | 69.41/134.61 | 1.72 | 0.00 | 60.23 | 1 | 300/300 | 1800 |
| affix_endsWith_address/count | 119.25/120.20 | 0.88 | 0.00 | 0.04 | 1 | 1/1 | 0 |
| affix_endsWith_address/list300 | 55.48/117.27 | 1.80 | 0.00 | 60.01 | 1 | 300/300 | 1800 |
| affix_startsWith_memo/count | 2.08/3.03 | 0.75 | 0.00 | 0.01 | 1 | 1/1 | 0 |
| affix_startsWith_memo/list300 | 6.84/30.15 | 1.53 | 0.00 | 21.19 | 1 | 101/101 | 606 |
| affix_endsWith_memo/count | 1.01/2.00 | 0.60 | 0.00 | 0.01 | 1 | 1/1 | 0 |
| affix_endsWith_memo/list300 | 3.34/6.06 | 1.40 | 0.00 | 1.20 | 1 | 6/6 | 36 |
| affix_startsWith_email/count | 0.92/1.64 | 0.61 | 0.00 | 0.02 | 1 | 1/1 | 0 |
| affix_startsWith_email/list300 | 4.15/6.71 | 1.33 | 0.00 | 1.29 | 1 | 6/6 | 36 |
| affix_endsWith_email/count | 350.09/350.97 | 0.79 | 0.00 | 0.04 | 1 | 1/1 | 0 |
| affix_endsWith_email/list300 | 7.11/88.97 | 2.16 | 0.00 | 59.92 | 1 | 300/300 | 1800 |
| affix_startsWith_company/count | 292.06/293.10 | 0.86 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| affix_startsWith_company/list300 | 9.98/75.64 | 6.40 | 0.00 | 63.12 | 1 | 300/300 | 1800 |
| affix_endsWith_company/count | 69.43/70.65 | 0.81 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| affix_endsWith_company/list300 | 17.74/82.58 | 2.39 | 0.00 | 62.37 | 1 | 300/300 | 1800 |
| like_prefix2plus/count | 3.28/4.67 | 0.68 | 0.00 | 0.01 | 1 | 1/1 | 0 |
| like_prefix2plus/list300 | 4.51/7.28 | 1.36 | 0.00 | 1.31 | 1 | 6/6 | 36 |
| like_suffix2plus/count | 1247.29/1248.09 | 0.85 | 0.00 | 0.05 | 1 | 1/1 | 0 |
| like_suffix2plus/list300 | 16.17/91.33 | 1.71 | 0.00 | 62.64 | 1 | 300/300 | 1800 |
| like_contains2plus/count | 1.49/2.38 | 0.74 | 0.00 | 0.02 | 1 | 1/1 | 0 |
| like_contains2plus/list300 | 6.66/10.15 | 1.40 | 0.00 | 1.72 | 1 | 9/9 | 54 |
| exact_common/listAll | 153.25/5693.46 | 1.44 | 0.00 | 5523.86 | 1 | 28331/28331 | 169986 |
| sub_rare/listAll | 3.43/26.08 | 1.13 | 0.00 | 19.81 | 1 | 101/101 | 606 |
| exact_one/listAll | 0.78/1.86 | 0.68 | 0.00 | 0.29 | 1 | 1/1 | 6 |

## 미달 조건과 EXPLAIN

미달은 연구 대비 >1.10배이면서 절대 차이 >1ms인 경우다. SQL 또는 전체 >1초도 별도 표시한다. EXPLAIN은 모든 교차 측정 후 별도 1회이며 중앙값이 아니다. 근거: [plans.json](plans.json).

| 조건/종류 | SQL 배율 | 전체 배율 | 1초 초과 | EXPLAIN 관찰 |
| --- | --- | --- | --- | --- |
| exact_common/list300 | 1.28 | 0.90 | 없음 | Limit 5.41ms×1 (300행); Sort 5.40ms×1 (300행); Nested Loop 5.31ms×1 (300행) |
| sub_mid/count | 1.15 | 1.15 | 없음 | Aggregate 192.34ms×1 (1행); Bitmap Heap Scan 190.92ms×1 (16574행); Bitmap Index Scan 3.94ms×1 (16574행) |
| sub_mid/list300 | 1.17 | 1.07 | 없음 | Limit 71.69ms×1 (300행); Sort 71.68ms×1 (300행); Nested Loop 71.58ms×1 (300행) |
| sub_rare/list300 | 1.83 | 1.09 | 없음 | Limit 5.20ms×1 (101행); Sort 5.19ms×1 (101행); Nested Loop 5.14ms×1 (101행) |
| starts/list300 | 1.28 | 1.12 | 없음 | Limit 50.87ms×1 (300행); Sort 50.85ms×1 (300행); Nested Loop 50.70ms×1 (300행) |
| and2/list300 | 1.42 | 1.24 | 없음 | Limit 123.35ms×1 (300행); Sort 123.34ms×1 (300행); Nested Loop 123.25ms×1 (300행) |
| and4/count | 1.06 | 1.15 | 없음 | Aggregate 9.15ms×1 (1행); Bitmap Heap Scan 9.13ms×1 (62행); Bitmap Index Scan 5.47ms×1 (554행) |
| and4/list300 | 1.36 | 1.22 | 없음 | Limit 15.82ms×1 (62행); Sort 15.82ms×1 (62행); Nested Loop 15.78ms×1 (62행) |
| and6/list300 | 1.17 | 0.99 | 없음 | Limit 30.22ms×1 (300행); Sort 30.20ms×1 (300행); Nested Loop 30.03ms×1 (300행) |
| or3/list300 | 3.57 | 2.72 | 없음 | Limit 2.90ms×1 (2행); Sort 2.90ms×1 (2행); Nested Loop 2.89ms×1 (2행) |
| or_and_mix/list300 | 1.40 | 1.22 | 없음 | Limit 123.92ms×1 (300행); Sort 123.91ms×1 (300행); Nested Loop 123.82ms×1 (300행) |
| word_boundary/count | 1.10 | 1.11 | 없음 | Aggregate 392.91ms×1 (1행); Bitmap Heap Scan 390.52ms×1 (29843행); Bitmap Index Scan 7.00ms×1 (29843행) |
| zero_and_common2/count | 4.12 | 3.91 | 없음 | Aggregate 29.91ms×1 (1행); Gather 29.90ms×1 (3행); Aggregate 6.41ms×3 (1행) |
| zero_and_common3/list300 | 2.03 | 2.15 | 없음 | Limit 22.63ms×1 (0행); Sort 22.63ms×1 (0행); Nested Loop 22.62ms×1 (0행) |
| zero_fragment/list300 | 3.59 | 3.35 | 없음 | Limit 2.31ms×1 (0행); Sort 2.31ms×1 (0행); Nested Loop 2.30ms×1 (0행) |
| zero_fragment_long/list300 | 3.38 | 3.38 | 없음 | Limit 2.33ms×1 (0행); Sort 2.33ms×1 (0행); Nested Loop 2.33ms×1 (0행) |
| zero_or_all/list300 | 5.56 | 4.40 | 없음 | Limit 4.32ms×1 (0행); Sort 4.32ms×1 (0행); Nested Loop 4.31ms×1 (0행) |
| exact_zero/list300 | 4.18 | 4.27 | 없음 | Limit 1.77ms×1 (0행); Sort 1.77ms×1 (0행); Nested Loop 1.76ms×1 (0행) |
| sub_zero/list300 | 4.07 | 3.59 | 없음 | Limit 2.19ms×1 (0행); Sort 2.19ms×1 (0행); Nested Loop 2.19ms×1 (0행) |
| and3_or_rare/list300 | 1.35 | 1.09 | 없음 | Limit 40.65ms×1 (300행); Sort 40.64ms×1 (300행); Nested Loop 40.48ms×1 (300행) |
| exact_one/list300 | 4.34 | 3.70 | 없음 | Limit 1.88ms×1 (1행); Sort 1.88ms×1 (1행); Nested Loop 1.88ms×1 (1행) |
| sub2_common/count | 1.15 | 1.15 | 없음 | Aggregate 89.57ms×3 (1행); Bitmap Heap Scan 88.88ms×3 (10033.67행); Aggregate 113.84ms×1 (1행) |
| sub_mid_space/list300 | 1.27 | 0.98 | 없음 | Limit 11.21ms×1 (213행); Sort 11.20ms×1 (213행); Nested Loop 11.10ms×1 (213행) |
| space_address/count | 1.12 | 1.25 | 없음 | Aggregate 3.76ms×1 (1행); Bitmap Heap Scan 3.73ms×1 (213행); Bitmap Index Scan 1.08ms×1 (213행) |
| space_address/list300 | 1.23 | 1.00 | 없음 | Limit 7.22ms×1 (213행); Sort 7.21ms×1 (213행); Nested Loop 7.11ms×1 (213행) |
| affix_startsWith_name/count | 1.19 | 1.19 | 없음 | Aggregate 289.06ms×1 (1행); Bitmap Heap Scan 286.81ms×1 (28023행); Bitmap Index Scan 4.93ms×1 (28023행) |
| affix_endsWith_name/list300 | 3.93 | 2.33 | 없음 | Limit 2.79ms×1 (6행); Sort 2.79ms×1 (6행); Nested Loop 2.78ms×1 (6행) |
| affix_startsWith_phone/count | 1.12 | 1.15 | 없음 | Aggregate 16.05ms×1 (1행); Bitmap Heap Scan 15.94ms×1 (1251행); Bitmap Index Scan 1.38ms×1 (1410행) |
| affix_startsWith_phone/list300 | 1.32 | 1.01 | 없음 | Limit 12.97ms×1 (300행); Sort 12.96ms×1 (300행); Nested Loop 12.81ms×1 (300행) |
| affix_endsWith_phone/list300 | 1.82 | 1.04 | 없음 | Limit 7.34ms×1 (110행); Sort 7.34ms×1 (110행); Nested Loop 7.27ms×1 (110행) |
| affix_startsWith_address/count | 1.17 | 1.17 | 없음 | Aggregate 178.02ms×1 (1행); Bitmap Heap Scan 176.68ms×1 (16526행); Bitmap Index Scan 3.24ms×1 (16526행) |
| affix_startsWith_address/list300 | 1.17 | 1.06 | 없음 | Limit 37.04ms×1 (300행); Sort 37.02ms×1 (300행); Nested Loop 36.93ms×1 (300행) |
| affix_endsWith_address/list300 | 1.58 | 1.20 | 없음 | Limit 49.55ms×1 (300행); Sort 49.53ms×1 (300행); Nested Loop 49.40ms×1 (300행) |
| affix_startsWith_memo/list300 | 1.98 | 1.20 | 없음 | Limit 6.09ms×1 (101행); Sort 6.09ms×1 (101행); Nested Loop 6.02ms×1 (101행) |
| affix_endsWith_memo/list300 | 3.73 | 2.45 | 없음 | Limit 2.59ms×1 (6행); Sort 2.59ms×1 (6행); Nested Loop 2.59ms×1 (6행) |
| affix_startsWith_email/list300 | 3.58 | 2.39 | 없음 | Limit 3.28ms×1 (6행); Sort 3.28ms×1 (6행); Nested Loop 3.27ms×1 (6행) |
| affix_startsWith_company/count | 1.16 | 1.16 | 없음 | Aggregate 306.01ms×1 (1행); Bitmap Heap Scan 303.50ms×1 (30101행); Bitmap Index Scan 4.82ms×1 (30101행) |
| affix_endsWith_company/count | 1.09 | 1.10 | 없음 | Aggregate 64.48ms×1 (1행); Bitmap Heap Scan 63.99ms×1 (5883행); Bitmap Index Scan 1.18ms×1 (5883행) |
| like_prefix2plus/list300 | 3.49 | 2.27 | 없음 | Limit 3.88ms×1 (6행); Sort 3.88ms×1 (6행); Nested Loop 3.87ms×1 (6행) |
| like_suffix2plus/count | 2.31 | 2.31 | SQL/전체 | Aggregate 1262.12ms×3 (1행); Seq Scan 1258.42ms×3 (33333.33행); Aggregate 1287.18ms×1 (1행) |
| like_suffix2plus/list300 | 1.79 | 1.03 | 없음 | Limit 12.88ms×1 (300행); Sort 12.87ms×1 (300행); Nested Loop 12.74ms×1 (300행) |
| like_contains2plus/count | 1.97 | 2.27 | 없음 | Aggregate 1.23ms×1 (1행); Bitmap Heap Scan 1.22ms×1 (9행); Bitmap Index Scan 0.42ms×1 (10행) |
| like_contains2plus/list300 | 3.79 | 2.24 | 없음 | Limit 3.62ms×1 (9행); Sort 3.62ms×1 (9행); Nested Loop 3.61ms×1 (9행) |
| exact_common/listAll | 0.34 | 0.83 | 전체 | Nested Loop 89.66ms×3 (9443.67행); Gather Merge 147.47ms×1 (28331행); Index Only Scan 46.67ms×3 (9443.67행) |

노드 시간은 부모에 자식 시간이 포함되므로 더하지 않는다. EXPLAIN이 있는 경우의 관찰은 실행 계획 근거이며 특정 검사의 인과적 비용을 단독으로 입증하지 않는다.

### 남은 비용의 관찰

다음 값은 7회 중앙값과 분리한 EXPLAIN 1회에서 읽었다. 원인 분해가 완료된 성능 보장으로 해석하지 않는다.

| 조건 | 실행 계획 근거 | 해석 |
| --- | --- | --- |
| LIKE suffix count | Parallel Seq Scan, 합계 100000행; EXPLAIN 전체 1287.22ms, shared hit 16629/read 17653 blocks | 전체 행 LIKE 판정 경로가 남았다. SQL 중앙값 1233.05ms이며 함수 자체와 I/O 비용은 이 계획만으로 분리할 수 없다. |
| and2 목록300 | quick 264행 + fallback 36행. fallback 후보 28166행(추정1227), external merge 11576kB, fallback 117.04ms | 앞부분 결과 재사용은 동작하지만 남은 36행을 얻기 위한 후보 읽기·정렬 비용이 크다. |
| and3_or_rare 목록300 | quick 50행 + fallback 250행. 후보4808행(추정203), 정렬3768kB, fallback31.54ms | 이어찾기 후에도 후보 수 과소추정과 전체 후보 정렬이 관찰된다. |
| sub_mid count / 목록 | count Bitmap Index 실제16574행/추정25행. 목록 fallback 후보16376행/추정8행, external merge5912kB | 후보 선택도 추정과 실제 행 수가 크게 다르다. 판정 함수만의 비용으로 설명할 수 없다. |
| exact_zero 목록300 | sample1200행을 모두 읽고 quick에서1200행 제거(1.48ms); fallback Index Only Scan은0행 | 결과0건에도 앞부분 탐색이 실행돼 작은 조회의 고정 비용이 남는다. |
| exact_common 전체목록 | 28331행, 인증 복호화169986필드. SQL 중앙값161.45ms, 전체5820.44ms | 전체 시간의1초 초과는 SQL 이외 작업이 대부분이며 count의1초 초과와 구분한다. |

## 쓰기

독립 insert300 / memo update100 / delete100, 행마다 commit. 리셋·정답 확인은 시간 밖. 7회 배치 합계 중앙값/행과 배치 내 행 중앙값의 중앙값을 분리한다. 근거: [writes.json](writes.json).

| 작업 | 경로 | SQL ms/행 | 전체 ms/행 | 행 중앙값 ms | 배치 전체 ms | SQL 횟수/행 |
| --- | --- | --- | --- | --- | --- | --- |
| insert | plain | 0.44 | 0.48 | 0.44 | 145.34 | 3.00 |
| insert | research | 1.40 | 10.26 | 10.08 | 3078.61 | 4.00 |
| insert | product | 1.68 | 12.36 | 12.15 | 3708.36 | 4.00 |
| update | plain | 0.52 | 0.55 | 0.50 | 55.43 | 3.00 |
| update | research | 1.06 | 2.79 | 2.62 | 279.29 | 4.00 |
| update | product | 1.44 | 3.87 | 3.72 | 386.58 | 4.00 |
| delete | plain | 0.45 | 0.48 | 0.44 | 47.93 | 3.00 |
| delete | research | 0.45 | 0.47 | 0.44 | 47.39 | 3.00 |
| delete | product | 0.45 | 0.52 | 0.48 | 51.91 | 3.00 |

## 용량

MiB=2^20 bytes. 연구 경로에는 공유 native 암호 본문 전체 크기를 포함한다. 근거: [capacity.json](capacity.json).

| 경로 | 전체 MiB | bytes/행 | 평문 대비 |
| --- | --- | --- | --- |
| plain | 66.88 | 701.32 | 1.00× |
| research | 432.10 | 4530.91 | 6.46× |
| product | 476.05 | 4991.80 | 7.12× |

| 관계 | heap MiB | TOAST heap MiB | TOAST index MiB | 표 index MiB | 보조 MiB | 전체 MiB |
| --- | --- | --- | --- | --- | --- | --- |
| research_u.customers_plain | 19.00 | 0.00 | 0.01 | 47.84 | 0.03 | 66.88 |
| native_verify_main.customers | 37.12 | 0.00 | 0.01 | 3.03 | 0.04 | 40.20 |
| research_u.pb_4_final | 195.32 | 89.60 | 8.59 | 98.27 | 0.13 | 391.91 |
| test_final_return_product.customers | 37.13 | 0.00 | 0.01 | 4.26 | 0.04 | 41.43 |
| test_final_return_product.customers_seal_index | 260.72 | 0.00 | 0.01 | 173.80 | 0.10 | 434.63 |

로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다. 커밋하지 않았다.

## 조건 정의

근거: [cases.json](cases.json).

| 조건명 | 식 |
| --- | --- |
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

<!-- FINAL-RETURN-REMEASURE -->

## 최종 보완 측정: count 55개와 LIKE 목록 3개

제품 커밋 `6fc43de0497037efed55647034aec4269eb53c8f`, 완료 58/58개, 전체 완료 true. 원래 113개 결과와 쓰기·용량은 위에 그대로 보존했다. 이 절은 보완 커밋으로 함수 재설치·ANALYZE 후 같은 데이터·연결에서 평문/연구 최종안/제품을 예열2·교차7로 새로 측정한 결과다.

완료된 조회는 모두 원문 정규화 oracle과 일치했다. SQL 미달 11개, 전체 미달 14개, SQL >1초 0개, 전체 >1초 0개다. 1.10배 초과이면서 차이 >1ms를 미달로 판정한다. 

근거: [remeasure.json](remeasure.json). 첫 실행·pre/between/post·SQL 횟수·DB 반환·인증 복호화 횟수는 원시 결과에 보존했다. OS 캐시는 비우지 않았다. 내부 후보 수는 미계측이고 †는 C 로캘 한글 LIKE의 평문 비교 주의 표시다. 기존 세션과 새 세션의 절대 수치 차이는 단독 개선 근거로 삼지 않는다.

후속 일반 LIKE 수정과 분리하기 위해 git archive의 소스 트리 `a9c64d42c0eda72dbd0cb60e9bbfef5f5ee93ede`를 별도 빌드했다. 공유 작업 디렉터리의 src/dist는 사용하지 않았고 원래 일회용 DB guard를 호출했다.

### SQL 요청~응답 (ms)

| 조건 | 종류 | 평문 | 연구 최종안 | 제품 | 연구 대비 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| coarse_company_zero | count | 0.44 | 74.21 | 26.57 | 0.36× | 통과 |
| coarse_rare_and_memo † | count | 2.19 | 38.21 | 34.81 | 0.91× | 통과 |
| coarse_zero_and_memo † | count | 0.56 | 90.32 | 32.32 | 0.36× | 통과 |
| exact_common | count | 7.91 | 78.73 | 57.97 | 0.74× | 통과 |
| sub_common_memo † | count | 20.00 | 366.38 | 191.95 | 0.52× | 통과 |
| sub_mid † | count | 19.25 | 149.92 | 181.75 | 1.21× | 미달 |
| sub_rare † | count | 18.77 | 1.41 | 1.60 | 1.14× | 차이 ≤1ms |
| starts † | count | 7.00 | 98.37 | 92.99 | 0.95× | 통과 |
| ends | count | 16.40 | 578.23 | 449.76 | 0.78× | 통과 |
| and2 † | count | 10.25 | 260.49 | 161.61 | 0.62× | 통과 |
| and4 † | count | 7.08 | 7.95 | 8.24 | 1.04× | 통과 |
| and6 † | count | 7.46 | 27.44 | 28.32 | 1.03× | 통과 |
| or2 † | count | 19.07 | 135.88 | 120.91 | 0.89× | 통과 |
| or3 | count | 0.28 | 0.51 | 0.65 | 1.28× | 차이 ≤1ms |
| or_and_mix † | count | 21.03 | 378.67 | 169.61 | 0.45× | 통과 |
| word_boundary † | count | 18.63 | 367.76 | 405.45 | 1.10× | 미달 |
| sub45 † | count | 21.99 | 32.97 | 17.47 | 0.53× | 통과 |
| zero_and_common2 † | count | 10.06 | 7.00 | 28.70 | 4.10× | 미달 |
| zero_and_common3 † | count | 10.38 | 6.53 | 6.41 | 0.98× | 통과 |
| zero_fragment † | count | 22.83 | 0.65 | 0.55 | 0.85× | 통과 |
| zero_fragment_long † | count | 21.68 | 0.65 | 0.68 | 1.04× | 통과 |
| zero_or_all † | count | 35.51 | 0.69 | 0.75 | 1.09× | 통과 |
| exact_zero | count | 0.22 | 0.30 | 0.38 | 1.28× | 차이 ≤1ms |
| sub_zero † | count | 21.51 | 0.61 | 0.58 | 0.95× | 통과 |
| or4 † | count | 24.62 | 143.26 | 124.49 | 0.87× | 통과 |
| or5 † | count | 34.08 | 230.14 | 174.65 | 0.76× | 통과 |
| or6 † | count | 36.53 | 424.72 | 304.18 | 0.72× | 통과 |
| and2_or_and2 † | count | 23.88 | 203.79 | 177.87 | 0.87× | 통과 |
| or2_and_or2 † | count | 22.05 | 146.05 | 112.52 | 0.77× | 통과 |
| and3_or_rare † | count | 27.61 | 86.00 | 86.49 | 1.01× | 통과 |
| nested3 † | count | 32.42 | 268.14 | 241.51 | 0.90× | 통과 |
| exact_mid | count | 2.83 | 75.86 | 26.80 | 0.35× | 통과 |
| exact_one | count | 0.19 | 0.27 | 0.29 | 1.06× | 통과 |
| sub2_common † | count | 18.08 | 102.44 | 118.93 | 1.16× | 미달 |
| sub_mid_space † | count | 1.10 | 3.68 | 4.33 | 1.18× | 차이 ≤1ms |
| sub_long † | count | 20.64 | 91.55 | 79.87 | 0.87× | 통과 |
| word_inside_longer † | count | 16.89 | 279.47 | 158.50 | 0.57× | 통과 |
| space_memo † | count | 18.03 | 364.46 | 398.15 | 1.09× | 통과 |
| space_address † | count | 0.99 | 3.55 | 4.15 | 1.17× | 차이 ≤1ms |
| space_inside † | count | 16.68 | 281.22 | 158.68 | 0.56× | 통과 |
| affix_startsWith_name † | count | 10.38 | 237.47 | 288.12 | 1.21× | 미달 |
| affix_endsWith_name | count | 0.20 | 0.39 | 0.45 | 1.16× | 차이 ≤1ms |
| affix_startsWith_phone | count | 1.77 | 12.63 | 14.22 | 1.13× | 미달 |
| affix_endsWith_phone | count | 0.54 | 2.35 | 2.59 | 1.10× | 차이 ≤1ms |
| affix_startsWith_address † | count | 7.24 | 149.03 | 172.61 | 1.16× | 미달 |
| affix_endsWith_address † | count | 18.03 | 106.15 | 111.81 | 1.05× | 통과 |
| affix_startsWith_memo † | count | 0.65 | 1.53 | 1.69 | 1.10× | 차이 ≤1ms |
| affix_endsWith_memo | count | 0.35 | 0.73 | 0.80 | 1.10× | 통과 |
| affix_startsWith_email | count | 0.52 | 1.03 | 1.27 | 1.23× | 차이 ≤1ms |
| affix_endsWith_email | count | 21.96 | 540.46 | 356.48 | 0.66× | 통과 |
| affix_startsWith_company † | count | 12.60 | 315.46 | 383.71 | 1.22× | 미달 |
| affix_endsWith_company † | count | 37.06 | 54.38 | 60.76 | 1.12× | 미달 |
| like_prefix2plus | count | 0.37 | 1.06 | 0.98 | 0.93× | 통과 |
| like_suffix2plus | count | 22.96 | 581.54 | 385.40 | 0.66× | 통과 |
| like_contains2plus | count | 0.30 | 0.77 | 0.78 | 1.02× | 통과 |
| like_prefix2plus | list300 | 0.66 | 1.35 | 4.90 | 3.64× | 미달 |
| like_suffix2plus | list300 | 1.42 | 9.58 | 6.98 | 0.73× | 통과 |
| like_contains2plus | list300 | 0.53 | 1.13 | 4.09 | 3.62× | 미달 |

### 전체 시간 (ms)

| 조건 | 종류 | 평문 | 연구 최종안 | 제품 | 연구 대비 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| coarse_company_zero | count | 0.49 | 74.65 | 27.62 | 0.37× | 통과 |
| coarse_rare_and_memo † | count | 2.28 | 38.85 | 36.18 | 0.93× | 통과 |
| coarse_zero_and_memo † | count | 0.64 | 90.88 | 33.65 | 0.37× | 통과 |
| exact_common | count | 7.98 | 79.40 | 58.65 | 0.74× | 통과 |
| sub_common_memo † | count | 20.08 | 367.30 | 192.90 | 0.53× | 통과 |
| sub_mid † | count | 19.32 | 150.38 | 182.75 | 1.22× | 미달 |
| sub_rare † | count | 18.83 | 1.78 | 2.55 | 1.43× | 차이 ≤1ms |
| starts † | count | 7.08 | 98.74 | 93.81 | 0.95× | 통과 |
| ends | count | 16.47 | 578.87 | 451.12 | 0.78× | 통과 |
| and2 † | count | 10.33 | 261.05 | 163.02 | 0.62× | 통과 |
| and4 † | count | 7.15 | 8.92 | 10.65 | 1.19× | 미달 |
| and6 † | count | 7.54 | 28.82 | 30.68 | 1.06× | 통과 |
| or2 † | count | 19.15 | 138.69 | 122.03 | 0.88× | 통과 |
| or3 | count | 0.31 | 1.11 | 1.85 | 1.66× | 차이 ≤1ms |
| or_and_mix † | count | 21.11 | 379.52 | 171.01 | 0.45× | 통과 |
| word_boundary † | count | 18.70 | 368.31 | 406.70 | 1.10× | 미달 |
| sub45 † | count | 22.04 | 34.50 | 19.77 | 0.57× | 통과 |
| zero_and_common2 † | count | 10.14 | 7.67 | 29.77 | 3.88× | 미달 |
| zero_and_common3 † | count | 10.47 | 7.37 | 7.81 | 1.06× | 통과 |
| zero_fragment † | count | 22.88 | 1.14 | 1.53 | 1.34× | 차이 ≤1ms |
| zero_fragment_long † | count | 21.72 | 1.45 | 2.14 | 1.48× | 차이 ≤1ms |
| zero_or_all † | count | 35.57 | 1.85 | 2.45 | 1.33× | 차이 ≤1ms |
| exact_zero | count | 0.24 | 0.48 | 0.83 | 1.72× | 차이 ≤1ms |
| sub_zero † | count | 21.55 | 1.08 | 1.57 | 1.45× | 차이 ≤1ms |
| or4 † | count | 24.70 | 144.64 | 126.25 | 0.87× | 통과 |
| or5 † | count | 34.15 | 231.70 | 176.96 | 0.76× | 통과 |
| or6 † | count | 36.61 | 426.53 | 307.14 | 0.72× | 통과 |
| and2_or_and2 † | count | 23.99 | 204.63 | 179.59 | 0.88× | 통과 |
| or2_and_or2 † | count | 22.13 | 147.45 | 114.85 | 0.78× | 통과 |
| and3_or_rare † | count | 27.68 | 86.92 | 88.53 | 1.02× | 통과 |
| nested3 † | count | 32.51 | 269.43 | 243.88 | 0.91× | 통과 |
| exact_mid | count | 2.88 | 76.20 | 27.39 | 0.36× | 통과 |
| exact_one | count | 0.20 | 0.42 | 0.65 | 1.53× | 차이 ≤1ms |
| sub2_common † | count | 18.14 | 102.77 | 119.72 | 1.16× | 미달 |
| sub_mid_space † | count | 1.13 | 4.19 | 5.47 | 1.31× | 미달 |
| sub_long † | count | 20.71 | 92.45 | 81.47 | 0.88× | 통과 |
| word_inside_longer † | count | 16.99 | 279.89 | 159.34 | 0.57× | 통과 |
| space_memo † | count | 18.09 | 364.97 | 399.19 | 1.09× | 통과 |
| space_address † | count | 1.01 | 4.00 | 5.15 | 1.29× | 미달 |
| space_inside † | count | 16.74 | 281.64 | 159.50 | 0.57× | 통과 |
| affix_startsWith_name † | count | 10.45 | 237.93 | 288.94 | 1.21× | 미달 |
| affix_endsWith_name | count | 0.22 | 0.62 | 1.05 | 1.69× | 차이 ≤1ms |
| affix_startsWith_phone | count | 1.81 | 13.08 | 15.27 | 1.17× | 미달 |
| affix_endsWith_phone | count | 0.58 | 2.66 | 3.33 | 1.25× | 차이 ≤1ms |
| affix_startsWith_address † | count | 7.30 | 149.44 | 173.47 | 1.16× | 미달 |
| affix_endsWith_address † | count | 18.09 | 106.61 | 112.71 | 1.06× | 통과 |
| affix_startsWith_memo † | count | 0.69 | 1.95 | 2.72 | 1.40× | 차이 ≤1ms |
| affix_endsWith_memo | count | 0.39 | 1.18 | 1.72 | 1.46× | 차이 ≤1ms |
| affix_startsWith_email | count | 0.56 | 1.55 | 2.51 | 1.61× | 차이 ≤1ms |
| affix_endsWith_email | count | 22.03 | 541.10 | 357.65 | 0.66× | 통과 |
| affix_startsWith_company † | count | 12.66 | 315.89 | 384.56 | 1.22× | 미달 |
| affix_endsWith_company † | count | 37.12 | 55.06 | 61.57 | 1.12× | 미달 |
| like_prefix2plus | count | 0.41 | 1.53 | 2.03 | 1.32× | 차이 ≤1ms |
| like_suffix2plus | count | 23.02 | 581.99 | 386.91 | 0.66× | 통과 |
| like_contains2plus | count | 0.32 | 1.28 | 1.61 | 1.26× | 차이 ≤1ms |
| like_prefix2plus | list300 | 0.72 | 3.99 | 9.43 | 2.36× | 미달 |
| like_suffix2plus | list300 | 1.47 | 92.48 | 92.49 | 1.00× | 통과 |
| like_contains2plus | list300 | 0.56 | 3.86 | 8.39 | 2.17× | 미달 |

| 조건/종류 | 첫 SQL/전체 ms | 제품 pre/between/post ms | SQL 횟수 | DB 반환/결과 | 인증 복호화 |
| --- | --- | --- | --- | --- | --- |
| coarse_company_zero/count | 30.27/36.46 | 0.81/0.00/0.06 | 1 | 1/1 | 0 |
| coarse_rare_and_memo/count | 45.45/47.79 | 1.18/0.00/0.06 | 1 | 1/1 | 0 |
| coarse_zero_and_memo/count | 33.84/35.11 | 1.15/0.00/0.06 | 1 | 1/1 | 0 |
| exact_common/count | 64.93/65.60 | 0.62/0.00/0.06 | 1 | 1/1 | 0 |
| sub_common_memo/count | 189.92/190.99 | 1.22/0.00/0.06 | 1 | 1/1 | 0 |
| sub_mid/count | 174.03/176.35 | 1.14/0.00/0.06 | 1 | 1/1 | 0 |
| sub_rare/count | 1.83/2.71 | 0.93/0.00/0.02 | 1 | 1/1 | 0 |
| starts/count | 92.51/93.63 | 0.77/0.00/0.06 | 1 | 1/1 | 0 |
| ends/count | 472.08/474.10 | 1.31/0.00/0.06 | 1 | 1/1 | 0 |
| and2/count | 161.11/162.27 | 1.23/0.00/0.05 | 1 | 1/1 | 0 |
| and4/count | 10.70/12.98 | 2.40/0.00/0.04 | 1 | 1/1 | 0 |
| and6/count | 32.56/36.42 | 2.44/0.00/0.04 | 1 | 1/1 | 0 |
| or2/count | 120.20/121.40 | 1.20/0.00/0.05 | 1 | 1/1 | 0 |
| or3/count | 0.93/2.47 | 1.17/0.00/0.01 | 1 | 1/1 | 0 |
| or_and_mix/count | 166.28/167.64 | 1.35/0.00/0.05 | 1 | 1/1 | 0 |
| word_boundary/count | 399.89/401.02 | 1.20/0.00/0.05 | 1 | 1/1 | 0 |
| sub45/count | 23.11/26.22 | 2.40/0.00/0.05 | 1 | 1/1 | 0 |
| zero_and_common2/count | 30.14/31.44 | 1.05/0.00/0.04 | 1 | 1/1 | 0 |
| zero_and_common3/count | 16.78/18.34 | 1.26/0.00/0.05 | 1 | 1/1 | 0 |
| zero_fragment/count | 0.84/2.34 | 0.96/0.00/0.02 | 1 | 1/1 | 0 |
| zero_fragment_long/count | 0.80/2.40 | 1.35/0.00/0.02 | 1 | 1/1 | 0 |
| zero_or_all/count | 1.02/2.96 | 1.69/0.00/0.01 | 1 | 1/1 | 0 |
| exact_zero/count | 0.44/0.92 | 0.41/0.00/0.01 | 1 | 1/1 | 0 |
| sub_zero/count | 0.62/1.59 | 0.87/0.00/0.02 | 1 | 1/1 | 0 |
| or4/count | 126.09/127.96 | 1.72/0.00/0.04 | 1 | 1/1 | 0 |
| or5/count | 177.38/179.58 | 2.10/0.00/0.04 | 1 | 1/1 | 0 |
| or6/count | 318.57/321.45 | 2.90/0.00/0.04 | 1 | 1/1 | 0 |
| and2_or_and2/count | 175.20/177.02 | 1.51/0.00/0.05 | 1 | 1/1 | 0 |
| or2_and_or2/count | 110.13/112.08 | 1.96/0.00/0.05 | 1 | 1/1 | 0 |
| and3_or_rare/count | 100.94/102.67 | 1.75/0.00/0.05 | 1 | 1/1 | 0 |
| nested3/count | 230.64/232.99 | 2.33/0.00/0.05 | 1 | 1/1 | 0 |
| exact_mid/count | 31.90/32.70 | 0.59/0.00/0.05 | 1 | 1/1 | 0 |
| exact_one/count | 0.38/0.89 | 0.36/0.00/0.01 | 1 | 1/1 | 0 |
| sub2_common/count | 114.04/114.94 | 0.74/0.00/0.05 | 1 | 1/1 | 0 |
| sub_mid_space/count | 5.48/6.52 | 1.05/0.00/0.04 | 1 | 1/1 | 0 |
| sub_long/count | 83.82/85.23 | 1.53/0.00/0.05 | 1 | 1/1 | 0 |
| word_inside_longer/count | 158.26/159.10 | 0.79/0.00/0.05 | 1 | 1/1 | 0 |
| space_memo/count | 403.92/404.87 | 0.99/0.00/0.05 | 1 | 1/1 | 0 |
| space_address/count | 5.37/6.57 | 0.95/0.00/0.04 | 1 | 1/1 | 0 |
| space_inside/count | 156.94/157.77 | 0.79/0.00/0.05 | 1 | 1/1 | 0 |
| affix_startsWith_name/count | 283.52/284.54 | 0.79/0.00/0.05 | 1 | 1/1 | 0 |
| affix_endsWith_name/count | 0.65/1.40 | 0.59/0.00/0.01 | 1 | 1/1 | 0 |
| affix_startsWith_phone/count | 18.67/19.66 | 0.93/0.00/0.05 | 1 | 1/1 | 0 |
| affix_endsWith_phone/count | 2.83/3.54 | 0.76/0.00/0.02 | 1 | 1/1 | 0 |
| affix_startsWith_address/count | 183.25/184.11 | 0.84/0.00/0.05 | 1 | 1/1 | 0 |
| affix_endsWith_address/count | 134.03/135.52 | 0.99/0.00/0.05 | 1 | 1/1 | 0 |
| affix_startsWith_memo/count | 2.12/3.17 | 0.95/0.00/0.03 | 1 | 1/1 | 0 |
| affix_endsWith_memo/count | 1.07/2.00 | 0.90/0.00/0.02 | 1 | 1/1 | 0 |
| affix_startsWith_email/count | 1.76/3.35 | 1.19/0.00/0.04 | 1 | 1/1 | 0 |
| affix_endsWith_email/count | 366.85/367.75 | 1.00/0.00/0.05 | 1 | 1/1 | 0 |
| affix_startsWith_company/count | 390.98/392.08 | 0.87/0.00/0.05 | 1 | 1/1 | 0 |
| affix_endsWith_company/count | 100.34/101.66 | 0.85/0.00/0.05 | 1 | 1/1 | 0 |
| like_prefix2plus/count | 0.91/1.93 | 0.98/0.00/0.02 | 1 | 1/1 | 0 |
| like_suffix2plus/count | 375.99/376.90 | 0.92/0.00/0.05 | 1 | 1/1 | 0 |
| like_contains2plus/count | 1.42/2.47 | 0.81/0.00/0.02 | 1 | 1/1 | 0 |
| like_prefix2plus/list300 | 10.19/19.63 | 2.05/0.00/2.14 | 1 | 6/6 | 36 |
| like_suffix2plus/list300 | 7.80/108.20 | 1.87/0.00/83.63 | 1 | 300/300 | 1800 |
| like_contains2plus/list300 | 5.86/10.14 | 1.96/0.00/2.23 | 1 | 9/9 | 54 |

오류: 없음. 미완료 조회: 없음. 종료 2026-09-29T08:23:55.132Z.

로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.
