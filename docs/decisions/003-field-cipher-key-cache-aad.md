# 003. 필드 키 캐시 + 256 shard + AAD 결속

- 상태: 확정 (2026-09-27)

## 결정

- AES-256-GCM 키는 `(keyScope, model, field, codec, codec 버전·파라미터, shard)`마다 HKDF-SHA-384로 **한 번** 파생해 non-extractable `CryptoKey`로 캐시한다.
- `shard`는 rowId의 FNV-1a 해시 하위 8비트다(256개).
- AAD에는 형식 머리, 모델, 필드, codec(버전·파라미터), keyScope, **dataScope, rowId**를 묶는다. 다른 행·필드·scope로 옮긴 암호문과 변조한 암호문은 인증에 실패한다.
- dataScope는 키 파생 튜플에서 뺐다. AAD에만 남는다. 테넌트 수가 늘어도 키 캐시가 커지지 않는다.
- 암호문 형식은 `[0x03][nonce 12][암호문 + tag 16]`이다. 평문 UTF-8 길이보다 29바이트 길다.
- 서버 수명 캐시는 고정 키에서 파생한 키(필드 키, 검색 프로필 HMAC 키)와 필드 문맥만 둔다. 크기는 스키마로 정해지며 LRU나 상한 설정이 없다. 행 값, 평문, 암호문, scope prefix는 서버 수명 동안 보관하지 않는다.

## 근거

- 이전 형식은 행×필드마다 HKDF로 키를 새로 파생했다. WebCrypto `deriveKey`가 호출당 **76 µs**로 복호화 비용의 대부분이었다. 호출당 고정비가 지배해서 64 B와 390 B의 비용이 같았다(원 측정 스크립트 삭제, 수치만 보존).
- 필드 키 재사용으로 20행×6필드 복호화가 **10.5 → 2.1 ms**가 됐다. 20행 페이지 전체는 20.4 → 4.2 ms였다 ([stages.json](../../bench/results/standard-review-2026-09-26/stages.json)의 `sub_mid`, `current` 대 `improvedKeyReuse`).
- 호출당 부가 처리(필드 문맥·AAD prefix 캐시, 행 ID 인코딩 재사용)를 줄여 복호화 1회가 **46.5 → 28.9 µs**가 됐다 ([구현 기록](../../bench/results/standard-core-implementation-2026-09-27.md)).
- [NIST SP 800-38D §8.3](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf): 무작위 96비트 IV에서 한 키의 암호화 호출은 **2³²회 이하**여야 한다. 필드 키를 공유하면 이 한도에 닿을 수 있어 256 shard로 나눈다. 전체 한도는 약 1.1조 회가 된다(계산값).
  - 호출 수는 **모든 테넌트를 합쳐** 키마다 센다. shard는 키를 나눌 뿐 한도를 강제하지 않는다. 특정 shard에 쓰기가 몰리면 전체 합계만으로는 판단할 수 없다. 키별 호출 수 감시는 운영 과제다.
- dataScope를 튜플에 넣으면 필드 6개 × shard 256 = 테넌트당 최대 1,536개 키가 필요하다(캐시 용량 계산). 그래서 뺐다. 행 결속은 AAD가 계속 보장한다.
- 1,000행 파생 fixture에서 두 번 예열 뒤 7회 교차 중앙값은 조건별 1.33–7.21 ms였다 ([basic-bench](../../bench/results/standard-product-basic-bench-2026-09-27.json), [고정 키 재측정](../../bench/results/standard-product-basic-bench-fixed-key-2026-09-27.json)).
- 행 결속 AAD가 빠지면 같은 scope 안에서 암호문을 다른 행으로 옮겨도 복호화가 성공한다. 결속하면 `AUTH_FAIL`이다 ([Drizzle 반증 실험 E7](../../bench/results/2026-09-27-drizzle-falsify/report-ko.md)).

## 기각안

| 안 | 기각 이유 |
|---|---|
| 행·필드마다 HKDF(이전 형식) | 호출당 76 µs. 복호화 비용의 대부분 |
| 동기 `node:crypto`로 교체 | 같은 형식에서 95 대 105 µs로 이득 없음. Workers 호환도 불리 |
| `UV_THREADPOOL_SIZE` 증대 | 16.9 → 18.7 µs/op로 이득 없음 |
| 순수 JS AES-GCM(@noble/ciphers) | WebCrypto 동시 실행과 같은 17 µs. 테이블 기반 AES의 상수 시간 보장 없음. 의존성 추가 |
| 행 단위 봉투(한 행의 필드를 AEAD 1회) | 부분 수정 시 읽기-수정-쓰기, 필드별 키·null 열 모델 상실. 보류 |
| dataScope를 키 튜플에 포함 | 테넌트 수에 비례해 캐시가 커진다 |
| 필드 키 캐시에 LRU·상한 설정 | 원인(테넌트별 키)을 없애면 불필요한 장치다 |
| AAD에서 rowId 제거(값 하나만으로 암호화) | 같은 scope 안 암호문 교체 공격에 약해진다. 편의를 위한 보안 약화라 금지([008](008-drizzle-integration.md)) |

## 대체 관계

- 대체하는 것: 행별 HKDF 형식, dataScope를 포함한 키 튜플(원 기록 삭제).
- 관련: [002](002-fixed-keys-no-db-policy.md), [008](008-drizzle-integration.md), [010](010-security-claim-limits.md).
