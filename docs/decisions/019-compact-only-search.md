# 019 — compact 2글자 검색만 저장

상태: 채택, 2026-09-29. [015](015-database-search-proofs.md)·[017](017-search-proof-review.md)의 singleton 및 words 스트림 결정을 대체한다. 성능 기준은 연구 최종안이며 이전 제품은 기준으로 삼지 않는다.

## 제거한 기능과 이유

1글자 검색을 지원하지 않는 원칙에 맞춰 `single1`과 LIKE의 1글자 literal 판정을 제거한다. 모든 정규화 literal 구간이 2글자 이상이어야 한다. `ab%cd`·`ab_cd`는 허용하고 `ab%z%cd`·`ab_z`는 기존 최소 길이 오류인 `QUERY_TOO_BROAD`로 거절한다. `%`·`_` 와 이스케이프는 유지한다. exact는 여전히 빈 값과 1글자 값을 허용한다.

`words2`는 compact와의 길이 차이로 정규화 공백 수를 정확히 노출하므로 제거한다. `respectWords`, `substring.wordBoundary`, 단어 경계 후보 토큰과 전용 보조 함수 `normalizeWords`도 제거한다. 보안과 편의를 교환하지 않는다. 독립 목적으로 사용되는 adjacent·start·end·skip 후보와 compact2 등장순번 도장은 유지한다.

## 저장·설치·정확성

substring은 token 배열과 compact2의 salt·length·stamps·offsets만 저장한다. 단일 문자·words 열과 LIKE 함수의 해당 인자가 사라진다. 관리형 insert/update/upsert/reindex는 현재 profile 열만 쓰며 NULL 묶음 검사와 삭제 cascade는 유지한다. 정렬·scope·필드·행 암호문 결속도 유지한다.

스키마 재생성 → `extraMigrationSql` 재실행 → 전체 `sealed.reindex` → 검색 순서다. 단어 경계 설정을 token descriptor에서 제거했으므로 이전 token 배열을 그대로 질의하지 않는다. 부분 재구축은 누락을 만들 수 있다. 이전 내부 LIKE 함수 overload는 설치 SQL에서 제거한다. 기존 저장 형식이나 제거한 공개 옵션을 보존하지 않는다.

## 성능 후보와 검증

스트림 제거 후 연구 최종안·평문·제품을 같은 원문 데이터로 비교한다. 부모 조건 없는 count의 companion 단독 계산, 판정 함수 검사 비용, MAIN/꼬리 키 색인은 벤치 전용 SQL 변형으로 켜고 끈 뒤 이득이 있을 때만 제품에 반영한다. 제품 옵션은 만들지 않는다. 복합 OR·AND도 일반 질의이며 흔한 목록의 quick/fallback 이점을 유지해야 한다.

코드 게이트·평문 대조 및 저장 열 부재 검사는 [구현 보고](../../bench/results/2026-09-29-final-impl/report-ko.md)에 기록한다. 성능 비교는 독립 측정자의 연구 최종안 기준표로 판정하며, 아직 측정하지 않은 후보를 채택했다고 표현하지 않는다.

## 누출 한계

제거한 두 스트림의 추가 채널은 사라지지만 기존 HMAC token 빈도·동시출현, 암호문/정규화 길이, compact 위치 순열과 관찰한 조각 키의 위치 복원은 남는다. 적대적 DB의 결과 완전성이나 SQL 판정 무결성을 보장하지 않는다. 스트림 제거를 전체 레코드 탈취 방어의 입증이나 운영 성능 보장으로 해석하지 않는다.
