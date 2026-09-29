# 100만 행 count 직렬 원인 — 저장 계획 분석

**결론:** worker 공급 부족이 아니라 **상관된 토큰의 후보 수 과소추정 → 읽을 페이지 과소추정 → 병렬 bitmap 후보 경로 탈락**이 가장 강한 설명이다. DB 접속·실행·제품 변경·커밋 없음. 근거는 `bench/results/2026-09-29-scale-count-million/measure.json`, `schema.json`, 측정 스크립트와 PostgreSQL 18 공식 소스다.

## 관측값과 추론

아래는 100만 행·병렬 상한4. 상한2/8에서도 두 직렬 조건의 계획 비용·행 추정은 같다. 시간은 예열2·교차7의 SQL 왕복 중앙값이며, EXPLAIN은 별도 실행이다.

| 조건 | 후보 토큰 수 | GIN 추정 → 실제 후보 | 과소추정 | 계획 전체 비용(시간 아님) | 예상 heap 읽기량 재구성 | 계획/기동 worker | SQL 실측 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 메모 서비스 | 3 | 64,667 → 400,970 | 6.2배 | 240,390.79 | 58,999페이지·460.93MiB | 4/4 | 1.145초 |
| 이메일 끝 biz.test | 14 | 816 → 265,980 | 326배 | 7,368.68 | 816페이지·6.38MiB | Gather 없음 | 5.522초 |
| 메모 서비스상담 | 7 | 517 → 298,430 | 577배 | 4,641.92 | 517페이지·4.04MiB | Gather 없음 | 4.032초 |
| 드문 메모 푸른달 | 3 | 1 → 1,010 | 1,010배 | 80.25 | 1페이지 | Gather 없음 | 0.0099초 |

- **직접 관측:** 이메일·상담은 `Aggregate → Bitmap Heap Scan → Bitmap Index Scan`. 서비스는 `Finalize Aggregate → Gather → Partial Aggregate → Parallel Bitmap Heap Scan → Bitmap Index Scan`. 같은 GIN과 같은 `PARALLEL SAFE`, COST1900 판정 함수가 사용된다. 따라서 GIN이 병렬 불가하거나 판정 함수가 unsafe해서 두 조건만 막힌 것이 아니다. Gather 자체가 없으므로 worker를 계획했지만 실행 때 확보하지 못한 경우도 아니다.
- **원인 코드:** `searchPieces`는 인접 조각·skip 조각·끝 경계를 생성한다. 서비스는 인접2+skip1, 상담은 인접4+skip3, 이메일은 인접7+skip6+끝1이다. 이들은 같은 문자열에서 함께 등장한다. PostgreSQL `mcelem_array_contain_overlap_selec`는 `@>` 원소의 출현을 독립으로 보고 확률을 곱한다. `STATISTICS 1000`과 VACUUM ANALYZE가 이미 적용됐어도 원소 간 상관을 배우지는 않는다. 원소 빈도 원본은 보존되지 않아 개별 곱의 완전 재현은 미검증이지만, 알고리즘과 수백 배 오차는 모두 확인됐다. [PG18 array selectivity 소스](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/adt/array_selfuncs.c)
- **페이지 문턱 재구성(추론):** 저장 용량의 heap 336,552페이지를 T, GIN 추정 후보를 N으로 두면 `ceil(2*T*N/(2*T+N))`이다. PG는 이 예상 페이지 수로 partial bitmap의 worker 수를 정하며 기본 `min_parallel_table_scan_size=8MB`(1,024페이지) 미만이면 0을 반환해 그 경로를 생성하지 않는다. 서비스는 기본 문턱×3을 넘을 때마다 worker 수가 늘어나는 규칙으로 4개가 되며, 상한8에서도4개라는 관측과 맞는다. **해당 GUC 및 당시 reloptions의 실제값은 저장 EXPLAIN에 없으므로 문턱 원인은 높은 확신의 재구성이다.** 현재 config는 기본값 주석이며 측정 스크립트는 상한만 변경한다. [PG18 worker 경로 생성](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/optimizer/path/allpaths.c), [비용·페이지 공식](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/optimizer/path/costsize.c), [공식 기본 문턱](https://www.postgresql.org/docs/18/runtime-config-query.html)
- **비용 추정도 함께 작아짐:** 두 직렬 조건의 최종 행 추정은272/172인데 실제는265,980/298,430이다. 더 중요한 것은 함수 호출 전 후보 자체가816/517로 추정된 점이다. 함수 COST1900이라도 기본 operator cost 기준 함수 비용은3,876/2,456으로만 계산된다. 실제 후보를 넣으면 약126만/142만이다(모두 planner 비용 단위). 전체 표를 도는 병렬 sequential 후보는 많은 행의 함수 비용을 부담하므로 이 잘못 싸게 보이는 직렬 bitmap에 밀릴 수 있다. 선택되지 않은 계획은 저장되지 않아 그 비용은 직접 관측하지 못했다.
- **부수 병목:** 실제 이메일 heap121,281페이지 중 lossy66,585, 상담139,207 중 lossy99,539이며 recheck 탈락58,936/89,102행이다. work_mem4MB에서 손실 bitmap이 늘어 추가 읽기·토큰 재검사를 만든다. 이 문제도 있지만 worker0의 일차 설명과는 별개다. 함수 자체의 실패로 탈락한 행은 두 조건 모두0이다.

## 병렬일 때 예상 시간 — 실측 아님

4 worker를 실제로 기동하고 나머지 작업의 유효 병렬도가3~4라고 **가정**한다. 직렬 GIN 생성은 그대로 두고 `S+(T−S)/E`를 적용했다. T는 위 SQL 중앙값, S는 별도 EXPLAIN의 GIN 생성(이메일129ms,상담71ms)이다. 서로 다른 실행에서 가져온 값이므로 정밀한 실행시간 분해가 아닌 가정 계산이다.

| 조건 | 현재 실측 | 4 worker, 유효3~4 가정 추정 | 해석 |
|---|---:|---:|---|
| 이메일 끝 | 5.522초 | 약1.48~1.93초 | 1초 이하 보장 불가 |
| 메모 상담 | 4.032초 | 약1.06~1.39초 | 1초 부근, 이하 보장 불가 |

실제 I/O 대역폭·worker 경합·lossy 재검사에 따라 더 느릴 수 있고 이 범위는 신뢰구간/상한이 아니다. 같은 세션 서비스의 상한2→4가1.744→1.145초로 개선된 것은 병렬 효용의 참고 근거일 뿐 이 두 조건의 속도를 증명하지 않는다. GIN bitmap 생성은 병렬 heap에서도 한 프로세스가 수행한다. [공식 병렬 bitmap 설명](https://www.postgresql.org/docs/18/parallel-plans.html)

## 일반적인 개선 방향(전부 미실험)

| 우선순위 | 방법 | 이 원인에 대한 효과와 한계 |
|---|---|---|
| 우선 검증할 일반 정책 | 검색 companion 전체에 `parallel_workers=4` 같은 관계 단위 병렬 정책을 적용한 대조 | 키워드·필드별 예외 없이, 예상 페이지 문턱 대신 병렬 bitmap 경로를 **검토**하게 한다. 강제 선택은 아니고 cost 비교와 서버 상한은 남는다. 기본 비용으로 함수 CPU 절약만 계산해도 이메일2,907·상담1,842가 setup1000을 넘으므로 현재 COST1900에서도 선택될 여지가 있다. 드문값은 비용80이라 직렬이 합리적이다. 실제 계획·동시 부하 재검증 전 채택하지 않는다 |
| 근본 원인 해결 | 후보 `@>`의 **상관관계를 반영하는 선택도 추정** 또는 상관곱을 피하는 일반 후보 표현 재설계 | 통계 target만 올리거나 proof 함수 COST만 올려서는 GIN 예상 후보/페이지 문턱을 고치지 못한다. PG의 배열 선택도·인덱스 추정 자체를 보완하려면 서버 확장/코어 또는 질의 구조 변경이 필요하다. 일반 `CREATE STATISTICS ... dependencies`는 임의 배열 원소 내부의 `@>` 상관을 학습하지 않는다. 즉시 가능한 제품 패치라고 제안하지 않는다 |
| 보조 튜닝 | 충분한 work_mem, 실제 서버에 맞는 병렬 setup·scan 문턱 보정 | lossy와 진입 장벽은 줄일 수 있으나 후보 오차를 고치지 않는다. 일괄0비용·강제 seq scan은 드문 질의까지 퇴행할 수 있어 권하지 않는다 |

관계 옵션은 검색·저장·키 전달 의미를 변경하지 않는다. 일반 후보 표현의 예로 인덱스에는 단일 조각을 사용하고 전체 정확 위치 판정은 유지하는 방식은 상관곱을 피할 수 있지만 후보가 증가하므로 **미검증 연구 방향**에 불과하다. 추가 저장 통계/표를 곧바로 도입하거나 보안을 낮추는 제안은 하지 않는다. 표 단위 병렬 옵션은 경로 생성 문턱을 해소하는 정책이지 통계 오류를 근치하는 방법이라고 부르지 않는다. [관계 parallel_workers](https://www.postgresql.org/docs/18/sql-createtable.html), [통계 dependencies 한계](https://www.postgresql.org/docs/18/planner-stats.html)

오프라인 추출 수치와 가정 계산은 [analysis.json](analysis.json)에 보존한다. 원본 연구 산출물은 수정하지 않았다.

## 최종 처리

코디네이터 판단: 이번 분석은 종결하고, 관계 단위 병렬 정책의 실제 계획·성능 검증과 토큰 상관을 반영하는 후보 수 추정 개선은 후속 과제로 남긴다. 현재 제품에는 적용하지 않는다.
