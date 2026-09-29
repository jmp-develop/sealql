# 실험 기록

새 설계·최적화·보안 완화를 제안하기 전에 이 문서를 먼저 읽는다. 이미 해 본 것을 다시 하지 않기 위한 한 장짜리 색인이다. 세부 과정과 원자료는 링크한 `bench/results/` 보고서에, 채택 결정은 [`decisions/`](decisions/README.md)에 있다. 새 실험이 끝나면 해당 표에 한 줄을 추가하거나 고친다(이 문서는 누적 일지가 아니라 늘 최신인 색인이다).

각 줄: **무엇을 했나 / 핵심 수치 / 결론과 이유 / 다시 꺼내려면 먼저 풀어야 할 것**. 수치는 로컬 일회용 DB·합성 fixture(`bench_realistic_100k`, 10만 행)의 관찰이며 운영 보장·보안 인증이 아니다.

## 1. 검색 구조와 저장 형식

| 시도 | 핵심 수치 | 결론과 이유 | 다시 꺼내려면 | 근거 |
|---|---|---|---|---|
| **현재: HMAC 16비트 후보 토큰 + GIN + 행별 salt 위치 도장, DB 판정** | count 복호화 0, 목록은 반환 행만 복호화 | 채택. 정확 count·LIKE·AND/OR를 DB 안에서 | — | [015](decisions/015-database-search-proofs.md), [019](decisions/019-compact-only-search.md), [020](decisions/020-companion-predicate-plans.md) |
| A: 후보를 앱이 복호화해 재확인 | 회사 count 1,118 ms 대 평문 8.2 ms | 기각. count에 복호화가 필요 | 복호화 없는 정확 판정 | [연구 최종](../bench/results/2026-09-29-count-final/report-ko.md) |
| B: 2–8글자 모든 부분 문자열 도장(위치 없음) | 용량 10.7배, 45자 0건을 2,440건으로 오판 | 기각. 9글자 이상 판정 불가 | 긴 질의 정확 판정 | 같은 곳 |
| C: MongoDB QE식 등장별 꼬리표 + 등장 수 장부 | count 0.2–2.6초(실제 MongoDB 8.2도 5.1만 행 0.14–3.0초), 용량 90배 이상 | 기각. 너무 느림, 장부 운영·쓰기 잠금. 강한 공격 재평가는 부분만(회사 5% 알려진 원문 30.6–70.4%) | 10만 행 200 ms 이하 | [연구 최종](../bench/results/2026-09-29-count-final/report-ko.md), [재평가](../bench/results/2026-09-30-mongo-reeval/v-astra/report-ko.md) |
| D: 행 nonce + HMAC 검증값 결합 | – | 기각. 10자 초과·공백 질의에 앱 확인 필요 | 앱 확인 없는 판정 | [연구 최종](../bench/results/2026-09-29-count-final/report-ko.md) |
| 꼬리표안(회사 칸만 C) | 일부 조건 개선, 흔한 회사·OR 퇴행 | 기각. 장부 노출·다중 스냅샷 연결·운영 부담 | – | 같은 곳 |
| stateful 검색, V2 암호화 posting page, 키 기반 bucket, DB 정책 모델 | stateful 태그 준비 533 ms, V2 0건 검색 43.5배 | 기각. DB 상태·느림·관리형 쓰기 불가 | [011](decisions/011-rejected-research-lines.md)의 실패 조건 | [011](decisions/011-rejected-research-lines.md) |
| 1글자 스트림(single1), 단어 경계 스트림(words2) | words2는 공백 수 정확 노출 | 제거. 1글자 검색 비목표, 누출 | – | [019](decisions/019-compact-only-search.md) |
| 필드 통합 토큰 배열 | AND4 67→19 ms | 기각. 부분 수정·골라내기 누락 위험. 다중 컬럼 GIN으로 같은 이득 | – | [007](decisions/007-multicolumn-gin-not-combined-array.md) |
| 2–4글자 n-gram, 17비트 조각, 규모 비례 조각 비트 | 누출 폭증 | 기각. 비트 규모 규칙은 정확 일치에만 | – | [004](decisions/004-token-layout-16bit.md) |

## 2. 성능

| 시도 | 핵심 수치 | 결론과 이유 | 근거 |
|---|---|---|---|
| **P1: 후보 조건에 정렬 토큰 최대 3개** | 평균 56.5→47.9 ms, 200 ms 초과 9→6, 1초 0 | 채택. 플래너 과소추정 해소, 결과 불변 | [024](decisions/024-candidate-token-selection.md) |
| P2/P3: 3개 + 나머지 비인라인 함수 검사, P4: 병렬 4 | 목록 39→67 ms 등 | 기각. 목록·소형 퇴행 | [024](decisions/024-candidate-token-selection.md), [마지막 비교](../bench/results/2026-09-29-lasthour/r9-impl/report-ko.md) |
| 검색 표 parallel_workers=4, work_mem 32MB | 200 ms 초과 11→8, AND6 +4 ms | 미채택. 일부 개선·소형 퇴행 / 효과 없음 | [질의 조정](../bench/results/2026-09-29-followup/query-tuning/report-ko.md) |
| 판정 함수 첫 등장 결합(A), 단일 탐색 결합 | 45자 17.6→133.7 ms | 연기. 반복 값·긴 질의 퇴행 | [021](decisions/021-like-normalization.md) |
| TOAST 목표값 조정 | 검색 표 TOAST 0 MiB | 불필요 | [021](decisions/021-like-normalization.md) |
| PostgreSQL 18 bytea→bigint 직접 형변환 | 3–8% | 연기. PG18 요구 | [형변환 실험](../bench/results/2026-09-29-next-cast-astra/section-ko.md) |
| 남은 병목 | 흔한 값 수만 건 count 200–450 ms: 일치 행마다 PL/pgSQL 도장 판정(1회 7–17 µs) | 저장 형식 불변 최적화는 뒤로 | [연구 최종](../bench/results/2026-09-29-count-final/report-ko.md) |

## 3. 누출 완화 (모두 기각, [025](decisions/025-leakage-reevaluation-and-rejected-mitigations.md))

현재 누출 수치는 [threat-model](threat-model.md)에 있다. 요지: 부분 검색을 켠 전화는 알려진 원문 1%·선택 삽입으로 99.8% 복원, 백업만으로는 0%. 그래서 형식 고정 칸은 **정확 일치만** 쓴다.

| 시도 | 핵심 수치 | 결론과 이유 | 근거 |
|---|---|---|---|
| 후보 토큰 비트 축소(10/12비트) | 충돌 인지 공격 99.6% 그대로(약한 공격의 3.1%는 착시), 드문 2글자 후보 최대 22.6배 | 기각 | [비트](../bench/results/2026-09-29-lasthour/m1-astra/report-ko.md), [전화 12비트](../bench/results/2026-09-29-followup/token-bits/report-ko.md) |
| 본문 길이 패딩(64 B) | 용량 1.68배, 공백 수 추측 98–100% | 기각. 정규화 길이가 그대로 드러남 | [최종 검토](../bench/results/2026-09-29-final-review/m1-astra/report-ko.md) |
| 가짜 값 통째로 k개(전화 k=1·3) | 후보 안 정답 100%, 후보 약 3개·12개, 검색어 관찰 100% 판별, 쓰기마다 새 더미면 두 스냅샷 100%, 후보 행 2.17·5.17배 | 기각. 후보 몇 개로 좁혀진 전화는 사실상 유출. 부분 검색 끄기가 비용 없이 0% | [조립·비용](../bench/results/2026-09-30-dummy-phone/dsol-a/report-ko.md), [관찰·스냅샷](../bench/results/2026-09-30-dummy-phone/dsol-b/report-ko.md) |
| 가짜 토큰 조각(무작위) | 미측정 | 기각(추정). 조립 조건이 걸러 내고 알려진 행이 분포를 드러냄 | [025](decisions/025-leakage-reevaluation-and-rejected-mitigations.md) |
| MongoDB식으로 저장 형식 교체 | 위 1절 C | 기각. 속도 | 위 |
| AWS식 토큰 분할(partition) | 미시험 | 기각(추정). 선택 삽입·관찰에 무력 | – |
| 코드 비공개·판정 함수 숨김 | – | 효과 없음. 함수 본문은 스키마 덤프·물리 백업에 포함되고, 공격은 저장값의 통계만 쓴다(Kerckhoffs). 함수에 키는 없다 | [025](decisions/025-leakage-reevaluation-and-rejected-mitigations.md) |
| 타 제품 색인 비교(Bloom, 정확 전용) | Bloom 전화 삽입 1000 77.4%·5% 10.4%, 정확 전용 전화 0% | 부분 검색을 켠 SealQL이 더 샌다. 전반적 우위 주장 금지 | [통합표](../bench/results/2026-09-30-competitor-sim/v-astra/report-ko.md) |

## 4. 공격·측정 방법 교훈

| 실수 | 올바른 방법 |
|---|---|
| 약한 공격의 낮은 복원율(0.03–3.64%)로 "누출 미미" 결론 → 방식 추천이 틀어짐 | 충돌 인지 조립·같은 scope 선택 삽입·알려진 원문 조립으로 **모든 후보를 같은 조건에서** 잰 뒤 비교 |
| 조립기가 해 0개 → 거짓 0%, 탐색 상한 도달을 안전으로 셈 | 공격자가 방식을 안다고 두고 그 방식을 인지한 조립기 사용. 상한 도달은 "미해결"로 분리 |
| 블라인드 복원 0건을 안전 근거로 씀 | 정답 사전 조건(8,594/10,000 복원)과 현실 비율(알려진 원문 0.01–1%)을 함께 |
| "한 번에 맞힘"만 보고 판단 | "후보 안 정답 포함"과 평균 후보 수를 함께. 후보 몇 개로 좁혀지면 위험한 값(전화)이 있다 |
| 템플릿 반복 합성 데이터로 누출·오탐 판단 | 실제 문장·값으로도 확인(합성 메모 19.33% 대 실제 리뷰 0.43%) |
| C 로캘 평문 `LIKE` 배율을 성능 주장에 사용 | 한글 LIKE는 테스트 DB에서 전체 스캔. "평문보다 빠르다" 금지 |
| 측정 순서·캐시 잔류를 제품 퇴행으로 오인 | 예열 2회, 교차 7회 중앙값, 계획·버퍼 적중 확인([P1 검증](../bench/results/2026-09-30-p1-verify/v-astra/report-ko.md)) |

## 5. 아직 재지 않은 것

T2(WAL·다중 스냅샷)의 전면 복원, 정확 일치 전용 SealQL의 같은 공격 수치, 실제 이름·자연어의 글자 단위 복원, 운영 규모·운영 데이터 성능.
