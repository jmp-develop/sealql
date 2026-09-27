# Drizzle 자연 통합 시제품 실측 (2026-09-27)

## 범위와 재현

연구 전용이다. `src/`는 변경하지 않았다. 설치 버전은 `drizzle-orm@0.45.3`, `drizzle-kit@0.31.11`, `pg@8.23.0`, `miniflare@4.20260730.0`이다. `node bench/drizzle-poc/runtime.mjs`, `node --import tsx bench/drizzle-poc/db.ts`, `npx drizzle-kit generate --config bench/drizzle-poc/drizzle.config.ts`를 `rtk proxy`로 실행했다. 원자료는 [runtime.json](runtime.json), [db.json](db.json), 생성 SQL은 [kit](kit/)에 있다. `db.ts`는 먼저 `assertDisposable`과 포트 `56439`를 확인하고, `127.0.0.1:56439`의 전용 `drizzle_poc` 스키마에 동작 확인용 세 행을 넣은 뒤 `DROP SCHEMA ... CASCADE`로 정리했다. `db.json`의 `cleanup`은 `true`다. 원본 스키마는 읽거나 수정하지 않았다.

| 가설 | 판정 | 관찰 |
|---|---|---|
| H1 | 확인 (가용성), 비용은 단일 환경 관찰 | Node 24.18.0과 Miniflare workerd `nodejs_compat`에서 동기 AES-256-GCM AAD 왕복과 잘못된 AAD 거부, HMAC-SHA-384 48바이트, HKDF-SHA-384 32바이트가 실행됐다. 각 연산 100회 순차 호출 평균 1회 ms: Node 동기/WebCrypto AES 0.0198/0.0559, HMAC 0.0157/0.0253, HKDF 0.0171/0.0518. workerd 0.13/0.01, 0.03/0.01, 0/0.06. WebCrypto 키 import는 시간에서 제외했다. workerd 타이머 해상도 때문에 0은 무비용이 아니다. 분포나 운영 성능을 뜻하지 않는다. |
| H3 | 부분 확인 | `customType`이 JSONB 한 값 `{ct,tokens}`을 직렬화·역직렬화했다. `drizzle-kit generate`는 `jsonb` 컬럼과 `USING gin ((sealed -> 'tokens'))`를 생성했다. `sealed.contains(col,'ab')` 형태의 SQL 헬퍼와 `and`/`or` 평문 조건 조합, insert/update/select/returning/onConflictDoUpdate/transaction/prepared가 실행됐다. `db.execute(sql\`...\`)`의 raw 결과는 `fromDriver`를 거치지 않아 JSONB 객체 그대로였다. 시제품의 `ct`는 암호문 대신 문자열로, 검색 오탐 재확인·AAD·인라인 토큰의 누출·갱신 비용을 검증하지 않았다. |
| H4 | 확인 (전달), 안전성 전체는 미확인 | Node와 workerd에서 두 병렬 `AsyncLocalStorage.run` 흐름이 각각 `a`, `b`를 `await` 뒤 동기 `getStore()`로 읽었다. 스코프가 없는 호출의 실패 처리, DB 커넥션 재사용과 장기 작업의 문맥 경계는 실측하지 않았다. |
| H5 | 부분 확인 | `drizzle({client})`에 `query`/`connect`를 감싼 Pool 형식 객체를 전달했다. 비동기 파라미터 치환과 결과 복호화가 raw execute, Drizzle 반환값, select, prepared, transaction에서 실행됐다. 저장된 값은 `cipher:aGVsbG8=`였다. `fields`의 원본 `secret`은 `tableID/columnID`가 실제 테이블 OID/열 번호와 일치했고 alias에서도 유지됐다. `upper(secret)`은 둘 다 0이므로 이 방식으로 원본 열을 식별하지 못했다. 파라미터가 어느 열에 쓰이는지 `pg.query`의 값만으로 알 수 없어 시제품은 `ENC:` 표시를 요구했다. 포괄적인 투명 변환은 검증되지 않았다. |
| H7 | 확인 (해당 경로) | `db.query.items.findMany({with:{children:true}})`의 중첩 `children[].note`가 `customType.fromDriver`를 거쳐 `"nested"` 문자열로 나왔다. 원시 JSONB는 `{ct,tokens}`이므로 변환이 확인된다. 다른 관계형 연산은 범위 밖이다. |

## 재현 코드의 경계

- [schema.ts](../../drizzle-poc/schema.ts)는 단일 컬럼 JSONB 구조와 GIN 식 색인을 선언한다. [db.ts](../../drizzle-poc/db.ts)의 `sealed.contains`는 JSONB 토큰 포함 조건이다. 실제 SealQL의 HMAC 조각 생성이나 인증 후 재확인을 대체하지 않는다.
- [db.ts](../../drizzle-poc/db.ts)의 `ProxyPool`은 비동기 `query`와 트랜잭션용 `connect`를 구현한다. `pg` 필드 메타데이터가 0인 표현식은 처리하지 않았고, 파라미터 출처도 SQL 파싱 없이 판별하지 않았다.
- [crypto.mjs](../../drizzle-poc/crypto.mjs), [worker.mjs](../../drizzle-poc/worker.mjs), [runtime.mjs](../../drizzle-poc/runtime.mjs)는 Node/workerd 기능과 짧은 로컬 시간 관찰만 기록한다. 암호 설계 변경의 보안 판단은 이 시제품 범위 밖이다.
