# R8 재측정

커밋: fc561aca92a5a0d43a43a362405dda068bf2f84b; dist SHA-256 전: ccb896ff19e10fec4d4151ceee5093fdafa1d7d0010320e8616597e284729eed; 후: ccb896ff19e10fec4d4151ceee5093fdafa1d7d0010320e8616597e284729eed

예열 2회, 평문·제품 교차 7회. 지표별 중앙값이므로 합산이 일치하지 않을 수 있다. 첫 측정 값은 JSON에 별도 기록했다. DB 후보 수는 제품 SQL 응답 행 수의 합계다. C 로캘의 한글 LIKE 평문 배율은 판정 제외. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.

| 조회 방식 | 조건 전문 | 환경 | 대상 행 수 | 실제 일치 | 결과 수 | DB 후보 수 | SQL 회수 | 인증 복호화 필드 수 | 평문 SQL / 합계 ms | 제품 전처리 / DB / SQL 사이 / 후처리 / 합계 ms | 복호화 wall ms | R8 전 합계 / DB ms | 평문 대비 DB / 합계 배율 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| findMany 200 | (company = "서울서비스 담당" AND memo contains "서비스") | 10만 단독 | 100000 | 21176 | 200 | 200 | 1 | 1200 | 1.45 / 1.54 | 1.44 / 3.24 / 0 / 42.43 / 47.33 | 36.54 | 없음 | 2.24 / 30.73 |
| findMany 200 | (company = "서울서비스 담당" AND address contains "서울" AND memo contains "상담" AND email contains "service") | 10만 단독 | 100000 | 62 | 62 | 62 | 1 | 372 | 135.17 / 135.3 | 2 / 13.01 / 0 / 13.5 / 28.42 | 11.27 | 없음 | 0.1 / 0.21 |
| findMany 200 | (name contains "민서" AND phone contains "-5" AND address contains "서울" AND memo contains "서비스" AND email contains "test" AND company = "서울서비스 담당") | 10만 단독 | 100000 | 624 | 200 | 200 | 1 | 1200 | 123.53 / 123.64 | 2.11 / 16.5 / 0 / 41.22 / 59.36 | 34.53 | 없음 | 0.13 / 0.48 |
| findMany 200 | (company = "서울서비스 담당" OR memo contains "푸른달") | 10만 단독 | 100000 | 28400 | 200 | 200 | 1 | 1200 | 1.25 / 1.33 | 1.28 / 3.17 / 0 / 39.9 / 44.71 | 33.73 | 없음 | 2.53 / 33.51 |
| findMany 200 | (phone = "42-5748-1542" OR phone = "21-7100-5875" OR name contains "pshxt") | 10만 단독 | 100000 | 2 | 2 | 3 | 1 | 14 | 0.56 / 0.62 | 1.47 / 1.68 / 0 / 0.65 / 3.71 | 0.46 | 없음 | 3.01 / 6.02 |
| findMany 200 | (company = "서울서비스 담당" AND memo contains "서비스") | 1억 속 회사 B | 100000 | 21176 | 200 | 200 | 1 | 1200 | 1.03 / 1.11 | 1.31 / 2.81 / 0 / 39.87 / 43.97 | 33.87 | 60.53 / 3.03 | 2.73 / 39.59 |
| findMany 200 | (company = "서울서비스 담당" AND address contains "서울" AND memo contains "상담" AND email contains "service") | 1억 속 회사 B | 100000 | 62 | 62 | 62 | 1 | 372 | 40.35 / 40.48 | 1.83 / 164.52 / 0 / 12.62 / 179.05 | 10.56 | 195.23 / 173.32 | 4.08 / 4.42 |
| findMany 200 | (name contains "민서" AND phone contains "-5" AND address contains "서울" AND memo contains "서비스" AND email contains "test" AND company = "서울서비스 담당") | 1억 속 회사 B | 100000 | 624 | 200 | 200 | 1 | 1200 | 4.98 / 5.08 | 1.98 / 13.52 / 0 / 42.7 / 59 | 35.47 | 85.91 / 14.04 | 2.72 / 11.61 |
| findMany 200 | (company = "서울서비스 담당" OR memo contains "푸른달") | 1억 속 회사 B | 100000 | 28400 | 200 | 200 | 1 | 1200 | 1.41 / 1.5 | 1.27 / 60.1 / 0 / 41.32 / 102.9 | 34.71 | 126.07 / 60.15 | 42.66 / 68.68 |
| findMany 200 | (phone = "42-5748-1542" OR phone = "21-7100-5875" OR name contains "pshxt") | 1억 속 회사 B | 100000 | 2 | 2 | 3 | 1 | 14 | 5.89 / 5.98 | 1.46 / 1.7 / 0 / 0.72 / 3.87 | 0.5 | 3.83 / 1.59 | 0.29 / 0.65 |
