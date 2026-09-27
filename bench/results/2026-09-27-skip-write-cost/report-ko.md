# 건너뛴 조각 쓰기 비용 측정

2026-09-27 · 일회용 PostgreSQL `127.0.0.1:56439` (`.local/pg-test`). `guard()`가 데이터 디렉터리·소유자·포트를 확인한 뒤 실행했다. `bench_realistic_100k.customers`에서 같은 1,000행을 읽어, `bench_standard_next_100k`에 만든 별도 `skip_write_probe_off`/`skip_write_probe_on` 테이블에 공개 API로 순차 단건 insert, `memo` 부분 update, delete를 실행했다. 제품의 현재 필드별 토큰 열 구조와 최신 checkout 코드를 그대로 사용했다. 원본 데이터는 읽기만 했고 두 probe의 부모·companion은 끝에 0행이다.

각 원본 행에서 두 변형을 교차 순서로 호출했다. insert와 delete는 첫 행을 기본 먼저, 다음 행을 건너뜀 먼저 시작하고, update는 그 반대 순서로 시작했다. 시간은 API 호출 전체의 로컬 wall time이며 각 작업·변형 1,000회 표본의 중앙값, p95(950번째 순서통계), 합계다. 암호화·토큰 생성·DB 쓰기가 포함된다.

| 작업 | 기본 중앙값 ms | 기본 p95 ms | 기본 합계 ms | 건너뜀 중앙값 ms | 건너뜀 p95 ms | 건너뜀 합계 ms |
|---|---:|---:|---:|---:|---:|---:|
| 단건 insert | 4.654 | 5.677 | 4,790.194 | 6.158 | 7.428 | 6,262.264 |
| `memo` 부분 update | 1.249 | 1.696 | 1,324.732 | 1.381 | 1.845 | 1,432.851 |
| delete | 0.385 | 0.546 | 414.982 | 0.386 | 0.540 | 412.981 |

| 지표 | 기본 | 건너뜀 |
|---|---:|---:|
| 행당 전체 토큰 평균 (6필드 정확+조각) | 120.894 | 186.681 |
| 행당 조각 토큰 평균 | 114.894 | 180.681 |
| companion 초기 크기, B | 163,840 | 163,840 |
| 1,000행 insert 직후 companion 크기, B | 4,497,408 | 6,594,560 |
| companion 크기 증가, B | 4,333,568 | 6,430,720 |
| update 직후 새 `memo` 값 검색 | 1,000행 | 1,000행 |
| update 직후 원래 값에서 첫 행 ID | 0행 | 0행 |
| delete 직후 새 `memo` 값 검색 | 0행 | 0행 |
| delete 직후 부모/companion 남은 행 | 0/0 | 0/0 |

크기는 `pg_total_relation_size`로 companion 테이블과 색인을 합한 값이다. 행당 토큰 수는 insert 직후 companion 배열의 `cardinality` 합계 평균이다. 두 변형의 전체 토큰 평균 차이는 65.787개, companion 증가량 차이는 2,097,152 B였다. insert 합계 차이는 1,472.070 ms였으며, update 합계 차이는 108.118 ms였다. 이 수치는 해당 순차 로컬 fixture의 측정값이다. 동시 쓰기, 장시간 WAL·GIN pending list 변화, 운영 PostgreSQL의 처리량은 측정하지 않았다.

원시 1,000회 시간과 정합성 결과는 `write-cost.json`에 있다. 제품 코드와 공개 API는 변경하지 않았다.
