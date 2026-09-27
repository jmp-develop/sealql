# 011. 기각된 연구 방향

- 상태: 확정 (2026-09-27). 이 방향들의 코드는 삭제했다. 결과 보고서만 증거로 남긴다.

## 결정

아래 네 방향은 제품에 넣지 않는다. 다시 검토하려면 새 결정 기록으로, 여기 적힌 실패 조건을 먼저 해결한 증거를 낸다. 강화 검색 모드가 필요해지면 standard 코어([001](001-search-hmac-pieces-gin-verify.md)–[007](007-multicolumn-gin-not-combined-array.md)) 위에 **새로** 설계한다.

## 1. stateful 검색 (조각 등장마다 새 PRF 태그 + DB 상태)

- 방식: 조각의 등장마다 순번(ordinal)을 매겨 PRF 위치·태그를 만들고, 순번 상태를 DB 상태 테이블에 둔다. 정적 스냅샷에서 토큰의 동일성·빈도를 숨긴다.
- 기각 이유:
  - **DB 상태 의존.** 고정 키·DB 정책 없음([002](002-fixed-keys-no-db-policy.md))과 맞지 않는다.
  - **느리다.** 흔한 회사명 정확 검색에서 28,331개 태그 준비가 **약 533 ms**(frontier SQL 5회)였고, 같은 공개 `findMany`는 803 ms(첫 후보 SQL 전 비SQL 730 ms)였다(원 측정 보고서 삭제, 수치만 보존). 별도 관찰에서 태그 준비 약 614 ms, 후보 SQL 577–840 ms, 4–5회 의존 probe가 남았다 ([판정 기록](../../bench/results/posting-pages-supervisor-verdict-ko.md)).
  - 흔한 조각 하나가 질의당 태그 한도(65,536)를 넘으면 검색이 거부된다.
  - 질의 시점에는 탐색 조각의 태그 집합과 일치 행이 드러난다. forward-private가 아니다.

## 2. V2 암호화 posting page (독립 HMAC locator + AEAD page)

- 방식: `(scope, field, 조각)`별 독립 locator 아래 행 ID 목록을 AES-GCM page로 봉인한다. 정적 스냅샷에서 행↔조각 연결을 숨긴다.
- 기각 이유:
  - **단일 anchor 실패.** 결과 0건인 `지사담`: 표준 142.089 ms 대 V2 6,185.773 ms, **43.534배**. 가장 드문 조각 하나로 후보 5,883행을 정하고 모두 인증 개봉한 뒤 버렸다 ([V2 연구](../../bench/results/posting-pages-v2-research-ko.md)).
  - **적응형 교집합**은 같은 사례를 19.235 ms, 후보 0으로 처리했지만(분모 45.309 ms 기준 **0.425배**), 분모 정의에 따라 비율이 흔들리고(142 ms 대 45 ms), 두 흔한 조각의 교집합 같은 경계(page 약 1,560개·7.8 MB, 추정)는 측정하지 않았다. 주 경로에 합쳐지지 않았다 ([판정 기록](../../bench/results/posting-pages-supervisor-verdict-ko.md)).
  - **관리형 쓰기 불가.** 쓰기·갱신·삭제·동시성·세대 교체가 구현되지 않았다. page를 제자리 재봉인하면 WAL·다중 스냅샷·MVCC dead tuple이 트랜잭션별 "건드린 locator 집합"을 행에 연결해 standard와 같은 행×조각 관계가 드러난다. 연구 fixture의 shuffle은 정적 구축에만 있는 속성이다.
  - manifest 길이(51–56 B)가 조각 빈도 대역을, 부분 page 길이(`29 + 39n`)가 항목 수를 드러냈다.
  - v1(조각별 공개 page 그룹, 전체 page 선행 로드)은 흔한 검색 2.170배, OR 7.927배로 실패한 부정 대조군이다 ([v1](../../bench/results/posting-pages-research-ko.md)).

## 3. 키 기반 bucket (조각마다 N개 버킷 중 하나에 토큰)

- 방식: 행·필드·조각마다 HMAC으로 버킷 하나를 정해 토큰 변형을 N개로 나눈다. 질의는 N개 변형을 모두 보낸다.
- 기각 이유 ([bucket 실험](../../bench/results/lightweight-report-ko.md)):
  - N=1/4/8에서 시간 개선이 없었고 드문 검색은 N이 커질수록 느려졌다(1.39 → 2.09 ms).
  - 같은 회사명 20행의 190쌍 중 토큰을 공유하는 쌍이 190/166/108로 일부만 줄었다. 긴 문자열은 여러 조각을 공유해 연결 확률이 다시 커진다(`1−(1−1/N)^k`).
  - 질의 로그에는 N개 변형이 모두 드러나고, 같은 값을 여러 번 삽입하면 변형을 수집할 수 있다.
  - 토큰 폭(16 → 64비트)이 동시에 바뀌어 순수 보안 효과가 입증되지 않았다.

## 4. 이전 재설계의 DB 정책 모델

- 방식: DB 정책·세대·canary 테이블, 호출마다 정책 확인, 온라인 이중 epoch 회전 상태 기계, admin provisioning·유지보수·adoption API.
- 기각 이유: 호출마다 준비 3.7–4.4 ms와 SQL 2–4회 추가([002](002-fixed-keys-no-db-policy.md), [stages.json](../../bench/results/standard-review-2026-09-26/stages.json)). 고정 키 원칙에서는 쓸모가 없는 복잡성이다. 이 모델의 옛 명칭은 Cloudflare 제품과 혼동되어 쓰지 않는다.

## 대체 관계

- 대체하는 것: stateful 제품 모드, V2 연구 코드, bucket 연구 코드, 이전 재설계 명세(원 기록 삭제).
- 관련: [001](001-search-hmac-pieces-gin-verify.md), [002](002-fixed-keys-no-db-policy.md), [010](010-security-claim-limits.md).
