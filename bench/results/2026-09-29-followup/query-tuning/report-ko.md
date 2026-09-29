# 검색 표 병렬 정책·work_mem 후속 실측

**결론:** 관계 workers=4는 대상11개 중 200ms 초과를 11→8개로 줄였으나 AND6 count는 30.42→34.71ms로 4.29ms 늘었다. 효과는 일부 계획의 직렬→병렬 또는 worker2→4 변경에서 왔으며, 후보 과소추정이 심한 이메일·서비스상담에는 효과가 없었다. work_mem32MB의 일괄 개선은 확인하지 못했다. 제품에는 적용하지 않았다. 후속 질의 측 변형은 [후보 토큰 최대3개 비교](cap3-report-ko.md)를 본다.

저장 데이터·제품 코드·판정 함수는 바꾸지 않고, 새 검색 표의 `parallel_workers` 관계 옵션과 측정 연결의 `work_mem`만 비교했다. 결과는 같은 연결의 교차 중앙값이며 로컬 합성 fixture 결과다. 운영 보장·보안 인증이 아니다.

## 조건

- HEAD `e3eb115` 빌드 후 공개 `sealed.insert`로 원본 fixture 100,000행을 새 자기 스키마에 적재했다. 적재는 네 개의 500행 배치를 병렬로 진행했으며 적재 경과 시간은 성능 벤치로 사용하지 않는다. 부모/검색 표 각각 100,000행과 표본 600개 칸 인증 복호화를 확인했다.
- 한 scope, 동일한 물리 데이터·연결·질의·ID 오름차순·목록300·6개 칸 투영을 사용했다. 처음 1회 별도, 예열2회, 순서 회전 교차7회다. 매회 count와 목록의 ID·전체 정규화 투영을 원본 평문과 대조했다.
- 네 제품 경로는 auto4(자동 병렬·4MB), parallel4(관계 workers=4·4MB), auto32(자동 병렬·32MB), parallel32(workers=4·32MB)다. 모든 경로의 연결 `max_parallel_workers_per_gather=4`를 고정했다. 관계 옵션·GUC 변경은 측정 구간 밖에서 수행했다. 원래 서버 설정과 행/ID 상관은 원시 결과에 있다.
- 최종 재측정에서 200ms를 넘었던 count9개와 일반 LIKE2개, 별도 count6개·목록6개 회귀 조건이다. 평문도 같은 연결에서 측정했다. C 로캘 한글 LIKE는 전체 스캔이므로 평문 배율을 성능 주장에 쓰지 않는다.
- SQL 요청~응답과 API 전체 시간을 분리했다. 지표별 중앙값은 더해서 다른 중앙값이 되지 않는다. count는 인증 복호화0, 목록은 실제 반환 칸만 복호화함을 매번 단언했다. 최초 실행은 OS 캐시를 비우지 않아 cold라고 부르지 않는다.

## 200ms 초과 대상 count

| 조건 | 일치 | plain SQL | auto4 SQL/전체 | parallel4 SQL/전체 | auto32 SQL/전체 | parallel32 SQL/전체 |
|---|---:|---:|---:|---:|---:|---:|
| ends | 26598 | 35.1 | 540.5/542.8 | 550.4/553.0 | 551.8/553.8 | 539.3/540.9 |
| word_boundary | 29843 | 41.4 | 484.8/486.4 | 499.2/500.6 | 504.1/505.2 | 506.4/507.9 |
| or6 | 59768 | 138.3 | 222.8/226.2 | 220.6/224.3 | 222.6/226.9 | 220.1/224.0 |
| nested3 | 23177 | 111.9 | 253.3/256.1 | 181.5/183.8 | 253.0/255.7 | 174.3/176.8 |
| space_memo | 29843 | 40.1 | 486.5/487.7 | 495.6/497.3 | 486.2/487.5 | 488.6/489.6 |
| affix_startsWith_name | 28023 | 9.9 | 365.2/366.0 | 127.2/128.1 | 369.0/370.1 | 127.2/128.3 |
| affix_endsWith_email | 100000 | 42.0 | 241.7/242.9 | 241.7/242.7 | 238.9/239.9 | 240.5/241.3 |
| affix_startsWith_company | 30101 | 9.4 | 374.0/375.1 | 131.2/132.1 | 374.5/375.9 | 125.0/125.9 |
| like_suffix2plus | 100000 | 39.3 | 245.9/246.8 | 241.5/242.5 | 240.2/241.3 | 238.1/239.1 |
| like_general_segments | 100000 | 37.5 | 428.1/429.4 | 422.4/423.4 | 418.0/419.1 | 419.7/420.8 |
| like_general_underscore | 100000 | 38.1 | 281.1/281.9 | 281.7/282.6 | 278.3/279.1 | 278.5/279.5 |

| 경로 | 대상11개 중 SQL>200ms | SQL>1000ms |
|---|---:|---:|
| auto4 | 11 | 0 |
| parallel4 | 8 | 0 |
| auto32 | 11 | 0 |
| parallel32 | 8 | 0 |

## 드문값·0건·목록 회귀

| 조건 | 모드 | 일치/반환 | auto4 SQL/전체 | parallel4 SQL/전체 | auto32 SQL/전체 | parallel32 SQL/전체 |
|---|---|---:|---:|---:|---:|---:|
| sub_rare | count | 101/1 | 1.82/2.63 | 1.77/2.47 | 1.66/2.47 | 1.77/2.49 |
| sub_zero | count | 0/1 | 0.72/1.60 | 0.62/1.54 | 0.48/1.33 | 0.58/1.66 |
| affix_startsWith_email | count | 6/1 | 1.13/2.01 | 0.96/1.82 | 1.10/2.01 | 1.08/1.92 |
| or3 | count | 2/1 | 0.70/2.12 | 0.80/2.00 | 0.67/2.13 | 0.91/2.09 |
| and6 | count | 624/1 | 30.42/33.02 | 34.71/37.17 | 29.98/32.21 | 33.73/35.92 |
| sub_common_memo | count | 40097/1 | 194.35/195.13 | 146.83/147.64 | 195.52/196.30 | 144.41/145.57 |
| sub_common_memo | list300 | 40097/300 | 7.70/81.68 | 7.64/83.40 | 7.86/85.57 | 7.58/84.75 |
| ends | list300 | 26598/300 | 9.96/82.44 | 9.82/84.95 | 10.18/87.79 | 10.08/86.47 |
| or6 | list300 | 59768/300 | 9.28/86.06 | 9.13/87.85 | 9.17/88.43 | 9.44/87.04 |
| sub_rare | list300 | 101/101 | 5.40/31.80 | 5.31/30.38 | 5.14/29.71 | 5.42/31.91 |
| like_general_segments | list300 | 100000/300 | 9.36/85.57 | 9.82/92.43 | 11.23/89.68 | 9.53/90.80 |
| like_general_underscore | list300 | 100000/300 | 7.29/84.53 | 8.48/85.53 | 8.05/81.76 | 7.61/89.95 |

## EXPLAIN 근거

각 경로에서 별도 `EXPLAIN (ANALYZE,BUFFERS,VERBOSE,FORMAT JSON)` 1회를 수집했다. 아래 heap 블록·재검사 탈락은 계획 노드에 출력된 값이며 병렬 worker 전체 합이라고 주장하지 않는다. 후보는 앱으로 전송되지 않으므로 SQL 응답 행 수와 혼동하지 않는다. 상세 조건·버퍼·행 추정은 원시 계획을 본다.

| 조건/모드 | 경로 | 스캔 | worker 계획/기동 | heap exact/lossy | recheck 탈락 | GIN 추정/실제 행 |
|---|---|---|---:|---:|---:|---:|
| ends/count | auto4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 20461/0 | 0 | 82/26598 |
| ends/count | parallel4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 20461/0 | 0 | 82/26598 |
| ends/count | auto32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 20461/0 | 0 | 82/26598 |
| ends/count | parallel32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 20461/0 | 0 | 82/26598 |
| word_boundary/count | auto4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 24319/0 | 0 | 51/29843 |
| word_boundary/count | parallel4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 24319/0 | 0 | 51/29843 |
| word_boundary/count | auto32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 24319/0 | 0 | 51/29843 |
| word_boundary/count | parallel32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 24319/0 | 0 | 51/29843 |
| nested3/count | auto4 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 2/2 | 6224/0 | 0 | 127142/160792 |
| nested3/count | parallel4 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 3793/0 | 0 | 127142/160792 |
| nested3/count | auto32 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 2/2 | 7141/0 | 0 | 127142/160792 |
| nested3/count | parallel32 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 3788/0 | 0 | 127142/160792 |
| affix_startsWith_name/count | auto4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 23555/0 | 0 | 621/28023 |
| affix_startsWith_name/count | parallel4 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 5319/0 | 0 | 621/28023 |
| affix_startsWith_name/count | auto32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 23555/0 | 0 | 621/28023 |
| affix_startsWith_name/count | parallel32 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 6264/0 | 0 | 621/28023 |
| affix_startsWith_company/count | auto4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 24415/0 | 0 | 821/30101 |
| affix_startsWith_company/count | parallel4 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 5233/0 | 0 | 821/30101 |
| affix_startsWith_company/count | auto32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 24415/0 | 0 | 821/30101 |
| affix_startsWith_company/count | parallel32 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 5401/0 | 0 | 821/30101 |
| like_general_segments/count | auto4 | Parallel Seq Scan | 4/4 | 0/0 | 0 | 0/0 |
| like_general_segments/count | parallel4 | Parallel Seq Scan | 4/4 | 0/0 | 0 | 0/0 |
| like_general_segments/count | auto32 | Parallel Seq Scan | 4/4 | 0/0 | 0 | 0/0 |
| like_general_segments/count | parallel32 | Parallel Seq Scan | 4/4 | 0/0 | 0 | 0/0 |
| like_general_underscore/count | auto4 | Parallel Seq Scan | 4/4 | 0/0 | 0 | 0/0 |
| like_general_underscore/count | parallel4 | Parallel Seq Scan | 4/4 | 0/0 | 0 | 0/0 |
| like_general_underscore/count | auto32 | Parallel Seq Scan | 4/4 | 0/0 | 0 | 0/0 |
| like_general_underscore/count | parallel32 | Parallel Seq Scan | 4/4 | 0/0 | 0 | 0/0 |
| sub_rare/count | auto4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 101/0 | 0 | 1/101 |
| sub_rare/count | parallel4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 101/0 | 0 | 1/101 |
| sub_rare/count | auto32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 101/0 | 0 | 1/101 |
| sub_rare/count | parallel32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 101/0 | 0 | 1/101 |
| sub_zero/count | auto4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 0/0 | 0 | 1/0 |
| sub_zero/count | parallel4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 0/0 | 0 | 1/0 |
| sub_zero/count | auto32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 0/0 | 0 | 1/0 |
| sub_zero/count | parallel32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 0/0 | 0 | 1/0 |
| and6/count | auto4 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 709/0 | 0 | 57/710 |
| and6/count | parallel4 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 494/0 | 0 | 57/710 |
| and6/count | auto32 | Bitmap Heap Scan,Bitmap Index Scan | 0/0 | 709/0 | 0 | 57/710 |
| and6/count | parallel32 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 551/0 | 0 | 57/710 |
| sub_common_memo/count | auto4 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 2/2 | 8503/0 | 0 | 6447/40097 |
| sub_common_memo/count | parallel4 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 5603/0 | 0 | 6447/40097 |
| sub_common_memo/count | auto32 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 2/2 | 8648/0 | 0 | 6447/40097 |
| sub_common_memo/count | parallel32 | Parallel Bitmap Heap Scan,Bitmap Index Scan | 4/4 | 5590/0 | 0 | 6447/40097 |

이메일 ends는 GIN 후보 추정82/실제26,598이며 총 추정 비용921.3으로 병렬 시작 비용1000보다도 낮다. workers=4를 지정해도 이 직렬 계획은 바뀌지 않는다. 서비스상담도 전체 추정 비용548.5로 같은 문제다. 반면 이름·회사 접두어는 직렬→worker4로, nested3·메모 서비스는 worker2→4로 바뀌었다. AND6는 GIN 후보 추정57/실제710으로 적은 작업인데도 worker4를 시작하며 절대4.29ms 퇴행했다.

끝 검색의 heap exact20,461/lossy0에서 4→32MB는 손실 bitmap을 복구할 여지가 없었다. 다른 조건의 상세 lossiness는 위 표와 원시 계획에 남겼다. 이 결과로 work_mem의 전역 상향을 권하지 않는다.

## 해석 경계와 운영 비용

관계 `parallel_workers`는 병렬 스캔에 사용할 worker 수에 영향을 주지만 병렬 계획 선택이나 실제 worker 확보를 보장하지 않는다. [PostgreSQL 18 CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html#SQL-CREATETABLE-STORAGE-PARAMETERS).

병렬 bitmap은 heap 읽기를 나누며 GIN bitmap 생성은 한 프로세스가 수행한다. 관계 옵션으로 후보 수 추정 자체가 정확해지는 것도 아니다. [PostgreSQL 병렬 계획](https://www.postgresql.org/docs/18/parallel-plans.html).

work_mem은 전체 연결의 총 메모리 한도가 아니라 개별 작업에 적용되고, 여러 작업·연결·worker가 동시에 사용하면 총 사용량이 커진다. 32MB를 전역 설정으로 무조건 권하지 않는다. [PostgreSQL 자원 설정](https://www.postgresql.org/docs/18/runtime-config-resource.html#GUC-WORK-MEM).

## 검증·산출물

실행: `node --import tsx bench/followup/r9-impl/load.ts`, 적재 완료 후 `node --import tsx bench/followup/r9-impl/tune.ts`. 측정 락을 획득한 실행만 시간 측정을 수행했다. `npx tsc -p bench/followup/r9-impl/tsconfig.json`, `python bench/followup/r9-impl/report-tuning.py`로 타입·7회 중앙값·복호화 수를 검사한다. [적재](load.json), [DDL](schema.json), [측정과 계획](measure.json), [자기 스키마 정리](cleanup.json).

동시 서비스 부하, 다른 ID/물리 순서, 다른 키·자료 분포, 다른 서버 설정은 미검증이다. 제품 구현·설정에 자동 적용하지 않았으며 후보의 채택 여부는 아래 실측 해석으로 구분한다.
