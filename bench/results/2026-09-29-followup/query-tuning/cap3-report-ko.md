# 후보 토큰 최대3개: 질의 측 변형

**결론:** 큰 과소추정 조건의 원인을 완화했다. 이메일 끝 count는 534.27→170.52ms, 서비스상담은 485.01→202.22ms, 대상11개 중 200ms 초과는 11→8개다. 다만 드문 이메일 `iae` 시작은 후보6→29(4.83배), SQL0.67→0.79ms(+0.12ms)여서 “드문 검색이 느려지면 기각”이라는 엄격한 기준의 무퇴행은 충족했다고 하지 않는다. 제품 채택은 보류한다. 이 작은 시간 차이가 재현성 있는 퇴행인지 별도 반복으로 확정하지 않았으며 후보 증가 자체는 정확한 COUNT 결과다.

제품·저장 형식·정확 판정 함수를 바꾸지 않고, 생성된 SQL의 모든 `@> $n::bigint[]` 후보 배열만 줄였다. 길이 N>3이면 기존 토큰 배열의 0, floor((N−1)/2), N−1번 원소를 남긴다. 이는 **토큰 배열 순서**의 앞·중간·끝이며 원문 글자 위치 기준 선택은 아니다. 연산자·검색어별 분기는 없다. exact 꼬리 토큰과 모든 도장 키·판정은 그대로다.

## 조건과 검증

- 같은 공개 API 적재본 100,000행, 같은 물리 연결에서 평문·제품(auto4)·cap3 순서를 회전하며 첫 측정 별도+예열2+교차7회. 관계 병렬 옵션 자동, work_mem4MB, max_parallel_workers_per_gather4를 두 제품 경로에 똑같이 적용했다. 측정 락을 사용했다.
- 대상 count11개+회귀 count6개·목록300 6개다. 매회 전체 ID 순서와 여섯 칸 정규화 값 또는 count를 평문 원본과 대조했다. count 복호화0, 목록 실제 반환×6을 단언했다. 목록300은 여섯 칸 투영과 ID 오름차순을 유지한다.
- 후보 수는 시간 측정 밖에서 공개 count SQL의 정확 도장 판정만 true로 치환한 별도 COUNT다. scope와 전체 AND/OR 식을 유지하며 LIMIT 전 전체 후보 집합을 센다. 따라서 앱 전송 행 수와 다르다. 원본 후보≤cap3 후보, 정답≤양쪽 후보를 전부 단언했다.
- EXPLAIN(ANALYZE,BUFFERS,VERBOSE)은 각 경로 별도1회다. SQL 요청~응답과 API 전체 중앙값을 분리하며 서로 다른 지표의 중앙값을 합하지 않는다. C 로캘 한글 LIKE 평문 배율은 성능 주장에 쓰지 않는다.

## 23조건 같은 연결 비교

단위 ms, SQL/전체. worker는 EXPLAIN 계획/실제 기동 수이며 후보는 LIMIT 전 전체 집합이다.

| 조건 | 모드 | 일치/반환 | 토큰 개수(각 조건) | 후보 기존→cap3 | 평문 SQL | 기존 SQL/전체 | cap3 SQL/전체 | SQL 차이 | worker 기존→cap3 |
|---|---|---:|---|---:|---:|---:|---:|---:|---|
| ends | count | 26598/1 | 14 | 26598→26840 | 33.78 | 534.27/536.13 | 170.52/172.50 | -363.75 | 0/0→3/3 |
| word_boundary | count | 29843/1 | 7 | 29843→29843 | 37.44 | 485.01/487.25 | 202.22/204.02 | -282.79 | 0/0→2/2 |
| or6 | count | 59768/1 | 3,7,5,14 | 75793→75878 | 94.03 | 227.94/231.57 | 205.02/209.30 | -22.92 | 4/4→4/4 |
| nested3 | count | 23177/1 | 3,1,5,1,1 | 24839→24839 | 93.25 | 256.68/259.23 | 253.99/257.00 | -2.69 | 2/2→2/2 |
| space_memo | count | 29843/1 | 7 | 29843→29843 | 36.76 | 476.34/477.48 | 201.05/202.07 | -275.29 | 0/0→2/2 |
| affix_startsWith_name | count | 28023/1 | 4 | 28023→28023 | 9.50 | 294.03/294.88 | 194.92/196.00 | -99.12 | 0/0→1/1 |
| affix_endsWith_email | count | 100000/1 | 4 | 100000→100000 | 23.22 | 248.77/249.70 | 233.98/235.13 | -14.79 | 4/4→4/4 |
| affix_startsWith_company | count | 30101/1 | 4 | 30101→30101 | 8.97 | 298.28/299.20 | 199.69/200.62 | -98.59 | 0/0→1/1 |
| like_suffix2plus | count | 100000/1 | 4 | 100000→100000 | 23.65 | 235.63/236.49 | 234.55/235.79 | -1.08 | 4/4→4/4 |
| like_general_segments | count | 100000/1 | 2 | 100000→100000 | 23.40 | 422.37/423.30 | 415.92/416.77 | -6.45 | 4/4→4/4 |
| like_general_underscore | count | 100000/1 | 1 | 100000→100000 | 23.14 | 272.86/273.88 | 275.92/276.92 | +3.05 | 4/4→4/4 |
| sub_rare | count | 101/1 | 3 | 101→101 | 19.61 | 1.52/2.44 | 1.32/2.03 | -0.20 | 0/0→0/0 |
| sub_zero | count | 0/1 | 5 | 0→0 | 20.69 | 0.52/1.38 | 0.48/1.33 | -0.04 | 0/0→0/0 |
| affix_startsWith_email | count | 6/1 | 4 | 6→29 | 0.30 | 0.67/1.26 | 0.79/1.41 | +0.12 | 0/0→0/0 |
| or3 | count | 2/1 | 7 | 4→4 | 0.39 | 0.52/1.65 | 0.50/1.60 | -0.02 | 0/0→0/0 |
| and6 | count | 624/1 | 1,1,1,3,5 | 644→644 | 109.03 | 28.04/30.44 | 27.09/29.41 | -0.95 | 0/0→0/0 |
| sub_common_memo | count | 40097/1 | 3 | 40097→40097 | 35.37 | 184.61/185.46 | 184.22/185.00 | -0.39 | 2/2→2/2 |
| sub_common_memo | list300 | 40097/300 | 3 | 40097→40097 | 1.48 | 6.95/69.28 | 6.93/68.95 | -0.02 | 0/0→0/0 |
| ends | list300 | 26598/300 | 14 | 26598→26840 | 1.58 | 9.31/66.63 | 9.40/67.34 | +0.09 | 0/0→0/0 |
| or6 | list300 | 59768/300 | 3,7,5,14 | 75793→75878 | 1.44 | 8.30/70.17 | 8.55/71.02 | +0.24 | 0/0→0/0 |
| sub_rare | list300 | 101/101 | 3 | 101→101 | 78.30 | 5.03/25.75 | 4.97/25.26 | -0.06 | 0/0→0/0 |
| like_general_segments | list300 | 100000/300 | 2 | 100000→100000 | 1.30 | 8.75/67.28 | 8.77/66.17 | +0.01 | 0/0→0/0 |
| like_general_underscore | list300 | 100000/300 | 1 | 100000→100000 | 1.28 | 6.74/65.42 | 6.76/64.72 | +0.01 | 0/0→0/0 |

| 경로 | 대상11개 중 SQL>200ms | SQL>1000ms |
|---|---:|---:|
| auto4 | 11 | 0 |
| cap3 | 8 | 0 |

## 계획과 읽기

| 조건/모드 | 경로 | GIN 행 추정(각 노드) | 스캔 | shared hit/read |
|---|---|---|---|---:|
| ends/count | auto4 | 82 | Bitmap Heap Scan,Bitmap Index Scan | 238/20726 |
| ends/count | cap3 | 26840 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 1059/20667 |
| word_boundary/count | auto4 | 51 | Bitmap Heap Scan,Bitmap Index Scan | 75/24409 |
| word_boundary/count | cap3 | 3571 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 663/24413 |
| or6/count | auto4 | 57100/1/2/1/25/82 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 1627/34909 |
| or6/count | cap3 | 57100/1/2/1/455/26840 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 1428/34670 |
| nested3/count | auto4 | 18998/28023/6447/57100/16574 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 839/23605 |
| nested3/count | cap3 | 18998/28023/6447/57100/16574 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 769/23577 |
| space_memo/count | auto4 | 51 | Bitmap Heap Scan,Bitmap Index Scan | 75/24409 |
| space_memo/count | cap3 | 3571 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 681/24395 |
| affix_startsWith_name/count | auto4 | 621 | Bitmap Heap Scan,Bitmap Index Scan | 34/23602 |
| affix_startsWith_name/count | cap3 | 2216 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 311/23649 |
| affix_endsWith_email/count | auto4 | 없음 | Parallel Seq Scan | 16730/18225 |
| affix_endsWith_email/count | cap3 | 없음 | Parallel Seq Scan | 17200/17755 |
| affix_startsWith_company/count | auto4 | 821 | Bitmap Heap Scan,Bitmap Index Scan | 35/24461 |
| affix_startsWith_company/count | cap3 | 2727 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 321/24499 |
| like_suffix2plus/count | auto4 | 없음 | Parallel Seq Scan | 16763/18192 |
| like_suffix2plus/count | cap3 | 없음 | Parallel Seq Scan | 17233/17722 |
| like_general_segments/count | auto4 | 없음 | Parallel Seq Scan | 16794/18193 |
| like_general_segments/count | cap3 | 없음 | Parallel Seq Scan | 17264/17723 |
| like_general_underscore/count | auto4 | 없음 | Parallel Seq Scan | 16794/18193 |
| like_general_underscore/count | cap3 | 없음 | Parallel Seq Scan | 17264/17723 |
| sub_rare/count | auto4 | 1 | Bitmap Heap Scan,Bitmap Index Scan | 111/0 |
| sub_rare/count | cap3 | 1 | Bitmap Heap Scan,Bitmap Index Scan | 111/0 |
| sub_zero/count | auto4 | 1 | Bitmap Heap Scan,Bitmap Index Scan | 16/0 |
| sub_zero/count | cap3 | 1 | Bitmap Heap Scan,Bitmap Index Scan | 10/0 |
| affix_startsWith_email/count | auto4 | 1 | Bitmap Heap Scan,Bitmap Index Scan | 36/0 |
| affix_startsWith_email/count | cap3 | 4 | Bitmap Heap Scan,Bitmap Index Scan | 56/0 |
| or3/count | auto4 | 2/2/1 | Bitmap Heap Scan,Bitmap Index Scan | 32/0 |
| or3/count | cap3 | 2/2/1 | Bitmap Heap Scan,Bitmap Index Scan | 20/0 |
| and6/count | auto4 | 57 | Bitmap Heap Scan,Bitmap Index Scan | 1091/0 |
| and6/count | cap3 | 57 | Bitmap Heap Scan,Bitmap Index Scan | 991/0 |
| sub_common_memo/count | auto4 | 6447 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 691/27821 |
| sub_common_memo/count | cap3 | 6447 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 692/27820 |
| sub_common_memo/list300 | auto4 | 6447/33333 | Index Scan,CTE Scan,Subquery Scan,Bitmap Heap Scan,Bitmap Index Scan | 1457/0 |
| sub_common_memo/list300 | cap3 | 6447/33333 | Index Scan,CTE Scan,Subquery Scan,Bitmap Heap Scan,Bitmap Index Scan | 1457/0 |
| ends/list300 | auto4 | 82 | Index Scan,CTE Scan,Subquery Scan,Bitmap Heap Scan,Bitmap Index Scan | 1565/0 |
| ends/list300 | cap3 | 없음 | Index Scan,CTE Scan,Subquery Scan | 1565/0 |
| or6/list300 | auto4 | 없음 | Index Scan,CTE Scan,Subquery Scan | 1366/0 |
| or6/list300 | cap3 | 없음 | Index Scan,CTE Scan,Subquery Scan | 1366/0 |
| sub_rare/list300 | auto4 | 1 | Index Scan,CTE Scan,Subquery Scan,Bitmap Heap Scan,Bitmap Index Scan | 930/0 |
| sub_rare/list300 | cap3 | 1 | Index Scan,CTE Scan,Subquery Scan,Bitmap Heap Scan,Bitmap Index Scan | 930/0 |
| like_general_segments/list300 | auto4 | 없음 | Index Scan,CTE Scan,Subquery Scan | 1305/0 |
| like_general_segments/list300 | cap3 | 없음 | Index Scan,CTE Scan,Subquery Scan | 1305/0 |
| like_general_underscore/list300 | auto4 | 없음 | Index Scan,CTE Scan,Subquery Scan | 1305/0 |
| like_general_underscore/list300 | cap3 | 없음 | Index Scan,CTE Scan,Subquery Scan | 1305/0 |

## 해석·한계

이메일 ends는 후보26,598→26,840(+0.91%)인 반면 GIN 추정82→26,840으로 바뀌고 직렬→worker3이 되었다. 서비스상담은 실제 후보29,843 그대로, GIN 추정51→3,571 및 직렬→worker2가 된다. 즉 이득은 후보를 줄였기 때문이 아니라 과소추정 완화와 병렬 계획 때문이다. 이름·회사 접두어도 직렬→worker1이 된다.

희귀 메모 count1.52→1.32ms/목록5.03→4.97ms, 0건0.52→0.48ms, 희귀 OR0.52→0.50ms다. 목록6개 중 최대 증가는 OR6의 +0.24ms다. 일반 LIKE underscore count의 +3.05ms(272.86→275.92)는 토큰이1개라 원본/변형 SQL·값·계획이 같은 대조 조건에서 관찰한 변동이며 cap3 알고리즘 효과로 단정하지 않는다. 200ms에 가까운 201–205ms 값도 임계치 미달로 포장하지 않는다.

전체 후보 토큰을 함께 보내면 상관된 조각의 빈도를 독립적으로 곱한 추정이 실제 후보 수보다 작아진다. cap3는 필요조건을 덜 보내 추정 감소를 완화한다. 후보는 늘 수 있지만 기존 도장 함수가 최종 의미를 판정하므로 정확성은 유지한다. 토큰·키의 새 종류나 저장 정보는 추가하지 않지만 공격 모형 전체를 새로 인증한 실험은 아니다.

동시 부하·다른 키/자료/ID 순서·대량 희귀 자연어는 미검증이다. 관계 workers4와 cap3를 조합하지 않았다. 이 23개만으로 모든 드문 검색의 퇴행 없음을 주장할 수 없다. 제품 변경은 하지 않았다. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.

## 재현

`node --import tsx bench/followup/r9-impl/cap3.ts`, `npx tsc -p bench/followup/r9-impl/tsconfig.json`, `python bench/followup/r9-impl/report-cap3.py`. 실제 완료 출력: `COMPLETE cap3 comparison`. [원시 지표·계획](cap3.json), [적재](load.json), [관계 옵션 실험](report-ko.md), [정리](cleanup.json).
