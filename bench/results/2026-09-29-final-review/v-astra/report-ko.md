# 검색 색인 보안 비교: SealQL과 상용·오픈소스

조사일: 2026-09-29. SealQL 기준: 제품 `7c14bda`. 공식 문서·설계 논문과 기존 기계적 시험을 비교했다. 경쟁 제품에 같은 공격을 실행한 실험은 아니며, 제품 코드·DB를 변경하지 않았다. **확실**은 확인한 문서·구조·기존 시험의 범위, **추정**은 그로부터의 비교 판단, **모름**은 공개 근거 또는 동등 실험 부족을 뜻한다.

## 1. 결론

**“상용보다 강하다” 또는 “상용과 동급이다”라는 포괄적 보안 문장은 쓸 근거가 없다.** 제품마다 지원 질의와 노출 정보가 달라 전체 순위를 매길 수 없다. 다음 세 가지는 구분해서 말할 수 있다.

| 비교 대상·조건 | SealQL의 상대적 위치 | 확신·근거 |
|---|---|---|
| MongoDB QE 동등·범위의 순수 DB 스냅샷 모델 | **빈도 은닉 축에서 약함.** SealQL은 결정적 후보 토큰의 행별 분포를 저장한다. QE의 구조화 암호 색인은 완료된 연산 사이의 DB 스냅샷에서 값의 동일성·빈도를 드러내지 않도록 설계됐다. | 구조 차이 **확실**. 모든 실제 침해에서 복원율이 더 높다는 뜻은 아님. [QE 보장 범위][M1], [설계 §6][M2], [당사 위협 모델][L1] |
| CipherStash EQL equality / Acra equality의 전체 값 HMAC | **정확 도장 자체의 행 간 연결은 덜 직접적.** 행별 salt 도장은 같은 값도 달라진다. 그러나 후보 토큰·길이·함께 켠 substring 색인이 남으므로 제품 전체가 더 강하다는 결론은 불가. | 이 제한된 구조 차이 **확실**, 전체 우열 **모름**. [EQL 저장 형식][C1], [Acra 검색][A1], [L1] |
| AWS beacon / CipherSweet의 절단 blind index | **같은 누출 계열이지만 동등 보안은 아님.** 비트 수·분할·값 분포·색인 수가 중요하다. SealQL의 DB 도장 판정은 정확한 결과와 관찰 조각 위치를 추가로 드러낸다. | 계열 분류 **확실**, 설정을 맞춘 전체 우열 **모름**. [AWS][W1], [CipherSweet][S1], [L1] |
| CipherStash Bloom match / Cloaked Search의 중복·순서 억제 설정 | **T4의 관찰 조각 위치·반복 노출 축에서 불리함.** SealQL은 실제 등장 위치를 계산할 수 있는 키를 DB에 보낸다. 비교 대상은 조각 집합이나 섞인 토큰으로 후보를 찾는다. 대신 같은 정확한 LIKE/count 기능을 제공하는 비교는 아니다. | 메커니즘 차이 **확실**, 공격 성공률의 배수·전체 우열 **모름**. [EQL text][C2], [Cloaked Search FAQ][I1], [당사 공격 시험][L2] |
| MongoDB 문자열 검색 미리보기 / SQL Server secure enclave | **단일 순위 불가.** 전자는 별도 미리보기 구조·제약과 검토 범위, 후자는 enclave 안의 복호화·비교 및 추가 신뢰 경계를 가진다. | 지원·신뢰 경계 **확실**, 동일 조건 전체 보안 우열 **모름**. [문자열 설정][M3], [enclave][T1] |

정확한 DB count와 일반 LIKE 지원은 **기능상의 차이**다. 그것을 더 적은 누출이나 더 강한 검색 보안으로 표현하면 안 된다.

## 2. 비교의 전제

| 공격자 | 이 보고서에서 가진 것 | 구분해야 할 것 |
|---|---|---|
| T1 | 키·질의 기록 없는 논리 DB 덤프: 본문 암호문, 검색 색인, 스키마, 행 수·크기 | 로그·실행 메모리까지 들어 있는 서버 이미지와 다름. 보조 색인/메타데이터는 포함함. |
| T3 | T1 + 일부 행의 원문 또는 관련 분포·사전 | 알려진 한 행의 여러 조각과 여러 토큰을 즉시 일대일로 대응할 수 있다고 가정하지 않음. 선택 원문 삽입은 별도 담당 시험. |
| T4 | T1 + 실행 중 DB가 받는 검색 표현·파생 키, DB 결과 집합·수, 반복 질의 | 검색어 원문 라벨을 추가로 아는 경우와 익명 검색키만 가진 경우를 구분. 정상 TLS의 수동 패킷만으로 인자가 보인다고 가정하지 않음. |

루트·본문 암호화 키는 공격자에게 없다. 악의적 DB의 결과 누락·거짓 count는 별도의 무결성 문제다. 여기서 “DB에서 정확한 count”는 정상 저장물·정상 실행에서 후보 수가 아닌 최종 조건의 일치 수를 DB가 계산한다는 뜻이며, 적대적 서버의 답을 인증한다는 뜻이 아니다. SealQL의 64비트 도장 충돌 가능성도 0이 아니다. [당사 위협 모델][L1]

정규화와 질의 의미를 맞춰야 한다. SealQL은 NFC·전각 ASCII 변환·ASCII 소문자화·공백 제거 후 검색하며, LIKE의 각 literal run도 최소 2글자다. 토큰화된 단어 검색이나 공백을 보존하는 substring은 동일 기능이 아니다. [현재 제품][L3], [MongoDB substring 의미][M4]

## 3. 질의 종류와 DB count

`후보`는 오탐을 허용한다. “부분 지원”은 사전에 정한 부분값/토큰화 설정을 요구하며 임의 SQL LIKE와 다르다. 외부 제품은 공식 기능·구조 확인이며 이번에 실행 검증하지 않았다.

| 제품·비교 구성 | 정확 일치 | 임의 부분 문자열 | 앞 / 끝 | 일반 LIKE | DB에서 최종 조건 count | 확신·근거 |
|---|---|---|---|---|---|---|
| SealQL standard | 지원 | 지원 | 둘 다 지원 | 지원, literal 최소2 | 지원, 복호화0; 도장 충돌·적대적 DB 제외 조건 | **확실**, [제품][L3], [58조건 검수][L4] |
| CipherStash EQL 3.0.4 `text_eq` / `text_match` | HMAC equality | n-gram Bloom **후보** match | 정확한 anchor 판정 미확인 | 명시적 미지원 | equality는 가능. Bloom match count를 평문 substring 정답 수로 보장할 수 없음 | **확실**, [text][C2], [count][C3] |
| AWS Database Encryption SDK beacon | SDK가 오탐 제거 | 임의 contains 미지원 | virtual field로 미리 정의한 부분값만 | 미지원 | DB의 beacon count는 후보 수. 최종 정답은 SDK 복호화·필터 후 | **확실**, [검색][W1], [질의 제한][W3], [부분값][W2] |
| MongoDB QE 동등·범위 | 지원; range는 숫자·날짜 계열 | 아래 미리보기로 분리 | 아래 미리보기로 분리 | 임의 regex/SQL LIKE와 다름 | 지원된 predicate + `count`/`$count`로 DB 계산 | 지원 문서 **확실**, 이 보고서의 실행 검증 없음. [연산][M5] |
| MongoDB QE 문자열 미리보기 | 동등 검색과 설정을 구분 | `encStrContains` | 전용 prefix/suffix 표현 | 일반 `%..._...%`가 아님 | 공식 substring predicate와 `$match`→`$count` 지원으로 DB 최종 count 가능하다고 **추정**; 이 조합 실행 미검증 | [substring][M4], [연산][M5], [미리보기 제한][M3] |
| Acra Community / Enterprise | 전체 값 HMAC | 일반 `%값%` 미지원 | EE의 설정된 길이 이내 prefix만 / suffix 미지원 | EE도 오른쪽 `%`만 | equality·지원 prefix는 HMAC 비교의 SQL count로 가능하다고 **추정** | 변환 규칙 **확실**, count 조합 실행 미검증. [Acra][A1] |
| IronCore Cloaked Search | 분석된 token match, 오탐 가능 | n-gram 설정 | prefix 설정 / reverse+index_prefixes로 suffix | 동등한 SQL LIKE 보장 미확인 | 검색엔진의 토큰 일치 수가 원문 substring 정답 수라는 보장 없음 | 오탐 **확실**, 모든 프록시 count 동작은 **모름**. [FAQ][I1], [n-gram][I2], [edge][I3], [reverse][I4] |
| CipherSweet | 절단 blind index **후보** | 범용 검색 목적 아님 | 사전 정의 transform의 부분값 | 미지원 | DB blind-index count는 후보 수. 정답은 앱 재확인 필요 | 구조·목적 **확실**, [위협 모델][S1], [FAQ][S2] |
| SQL Server Always Encrypted + secure enclave | 지원 | LIKE로 지원 | LIKE로 지원 | 지원, escape 등 제약 | enclave 평문 비교 후 일반 SQL count로 가능하다고 **추정** | 지원·신뢰 경계 **확실**, count 조합 실행 미검증. [Microsoft][T1] |

CipherStash의 Bloom `bf` 배열 값은 **필터의 비트 위치**다. SealQL의 **문자 등장 위치**와 혼동하면 안 된다. EQL text match는 순서·중복에 무관한 3-gram 집합 비교이며, 일반 LIKE를 지원하지 않는다고 명시한다. 이는 단순 해시 충돌 외에도 검색 의미의 차이다. [C2]

AWS compound beacon의 `BEGINS_WITH`·`CONTAINS`는 조립된 필드/부분 구성요소에 관한 연산이다. 암호화 원문 안의 임의 문자열 prefix/contains가 아니다. 다만 virtual field로 미리 정한 구간·부분값을 색인할 수 있어 “부분값 검색이 전혀 없다”는 문장도 틀리다. [W2], [W3]

조회한 MongoDB 매뉴얼은 현재 8.3으로 표시되지만 문자열 설정 페이지에는 **8.2 Public Preview, 운영 사용 금지, GA와 비호환** 경고가 남아 있다. 이 보고서는 그 미리보기 계약을 비교한다. substring 기본 허용 필드 상한60자, 질의 길이2–10 범위 설정 등 제약이 있으며 일부 상한은 별도 옵션으로 해제 가능하므로 “절대60자 한계”라고 단정하지 않는다. 현재 GA 여부를 교육 영상·검색 스니펫만으로 뒤집지 않았다. [M3], [M4]

## 4. 저장물과 공격자별 노출

아래의 “연결”은 키나 원문이 자동 복구된다는 뜻이 아니라 같은 색인 표현을 가진 행을 묶을 수 있다는 뜻이다. 기본적으로 암호문 크기와 DB 행 수도 보인다. 제품이 공개하지 않은 추가 padding/내부 저장 정책은 추측하지 않았다.

| 구성 | 무엇을 저장하는가 / 행별 salt·위치 | T1: 백업만 | T3: 원문·분포 추가 | T4: DB 검색 관찰 | 근거·확신 |
|---|---|---|---|---|---|
| SealQL | scope·필드별 결정적 절단 후보 토큰. 값·위치 도장은 셀별 salt. compact 정규화 길이와 도장 정렬에 대응한 위치 배열 | 토큰 동일성·문서 빈도·동시출현, UTF-8 길이, 정규화 길이. 도장만으로 같은 조각/값의 행 간 동일성을 직접 비교하지 못함 | 알려진 행·사전으로 후보 토큰 관계와 길이를 결합 가능 | 값 키로 해당 값 확인, 조각 키로 **그 조각의 모든 등장 위치·횟수** 확인. 같은 scope·필드의 미래 수정본도 재검사 가능 | **확실**, [L1], [L2] |
| EQL equality / Bloom | 결정적 HMAC `hm`, n-gram Bloom `bf`; 선택 구성의 OPE/ORE는 별도. 공개 형식에 SealQL형 셀별 위치 salt/문자 위치 없음 | equality는 동일 값·빈도. Bloom은 겹친 비트·집합 서명; ordering을 켜면 순서도 노출 | 알려진 값과 동일 HMAC 연결. Bloom 동시출현·비트 제약으로 추정 가능 | 반복 term·일치 행 관찰. Bloom은 거친 집합 검사를 제공하며 문서화된 문자 위치 확인 키는 없음 | 저장 구조 **확실**, 통계 공격의 성공 정도 **모름**. [C1], [C2], [C4] |
| AWS beacon | 절단 HMAC, 분할 번호를 유도 입력에 반영; 단일분할 또는 다중분할. 셀마다 위치 salt/위치 배열 없음 | 같은 분할에서 같은 값의 후보 동치류. 분할은 동일 값을 여러 태그로 분산; 충돌은 원문 일치와 태그 일치의 차이를 만듦 | 치우친 값·상관 필드가 충돌의 보호를 약화시킴 | 질의 beacon의 후보 집합·반복, 분할별 fan-out을 관찰. SDK의 최종 오탐 제거 결과가 DB 후보와 같다고 볼 수 없음 | 공식 구조 **확실**. 구성별 총 위험 우열 **모름**. [W1], [W2] |
| MongoDB QE 동등·범위 | 무작위화된 값·검색 태그, `__safeContent__`, ESC/ECOC 보조 컬렉션과 암호화 상태. 단순 결정적 whole-value blind-index 열과 다름 | 명시된 DB-only 스냅샷 모델에서 값의 동일성·빈도 은닉. 문서 형태/길이 관련 누출까지 없다는 뜻은 아님 | 빈도 동치류가 없으므로 결정적 태그와 같은 직접 매핑을 전제할 수 없음. 길이·비암호화 칸 등은 별도 | **백업+질의 기록 또는 지속 접근은 보장 범위 밖.** 특히 range는 적은 기록도 위험하다고 공식 경고 | 범위·설계 **확실**, 현 제품 공격 복원율 비교 **모름**. [M1], [M2] |
| MongoDB 문자열 미리보기 | QE 문자열용 색인·메타데이터와 길이/검색 설정 | 동등·범위 백서의 증명을 문자열 미리보기 전체로 자동 확장하지 않음 | 동일 데이터 공격 실험 없음 | 관찰 키의 위치·조각 복원 능력을 SealQL과 같은 방법으로 비교한 공개 근거 부족 | 세부 누출·우열 **모름**. [M3], [M4] |
| Acra | ciphertext 옆 결정적 HMAC. EE는 정해진 여러 prefix의 HMAC을 차례로 저장 | 값 동일성·빈도. EE는 prefix 길이별 동치류를 추가 공개 | 알려진 값/짧은 prefix를 같은 ClientID의 태그와 연결 가능 | 검색 HMAC과 해당 동치류 연결. 지원 prefix의 길이는 선택하는 태그 슬롯에도 반영 | 구조 **확실**, 전체 공격률 **모름**. [A1] |
| Cloaked Search | 필드·색인·선택 tenant별 keyed token. FAQ의 중복 제거·절단·무작위 순서 설정 | 토큰 문서 빈도·동시출현 잔존. 동일 문서 내 반복·원래 순서의 직접 노출을 줄임 | 사전·빈도·토큰 조합 추정 가능하다고 공식 인정 | 반복 검색·후보 행은 보이지만, 해당 설정에서 원래 문자 위치를 직접 주는 SealQL형 키/배열은 없음 | 억제 방식 **확실**, 동일 조건의 복원율 우열 **모름**. [I1] |
| CipherSweet | 필드·blind-index마다 별도 키의 절단 hash/KDF. 행별 색인 salt로 동일성 자체를 없애는 설계가 아님 | 충돌을 포함한 동치류. 많은/긴 색인을 결합하면 사실상 값 지문에 가까워질 수 있음 | 알려진/선택 원문 공격을 위협 모델에 포함. 다수 transform의 교집합이 위험 | 관찰한 blind-index 값의 후보 집합 연결. 본문/색인 master key와 위치 복원 키를 DB에 보내는 설계는 아님 | 구조·경고 **확실**, 실측 우열 **모름**. [S1] |
| Secure enclave | randomized encrypted column; enclave-enabled B-tree를 만들면 평문 순서대로 배치된 암호화 key | 값의 결정적 동일성 대신 index의 **순서 노출** 가능 | 순서·부가 정보 추론을 별도로 고려해야 함 | 평문·열 키는 enclave 안에서 사용. 외부 DB는 비교 결과·접근을 관찰; host 공격 방어는 enclave 종류/attestation에 의존 | 경계·순서 누출 **확실**, SealQL과 전체 우열 **모름**. [T1] |

**행별 salt가 있는지 하나만으로 등급을 매기면 안 된다.** SealQL은 salt로 도장을 분리하지만 결정적 후보 토큰은 남는다. 반대로 MongoDB QE는 SealQL식 위치 salt 배열 없이도 암호화 상태·서로 다른 태그로 스냅샷 빈도 연결을 억제한다. AWS의 분할 역시 SealQL의 사용자 scope와 같지 않다. 하나의 검색 범위 안에서 같은 값의 태그를 분산하는 기능이며 질의 fan-out이라는 대가가 있다. [L1], [M1], [W2]

## 5. 우리가 더 약한 지점과 입증의 한계

| 지점 | 판단 | 확신·근거 |
|---|---|---|
| 백업에서 후보 토큰 빈도 관계가 남음 | QE 동등·범위의 DB-only 스냅샷 목표보다 누출이 많다. 16비트 절단만으로 충분한 빈도 은닉이 된다고 주장할 수 없다. | **확실**, [M1], [M2], [L1] |
| 관찰한 조각을 정확한 위치에 배치 가능 | 집합형 후보 검색보다 더 세밀한 노출이다. prefix/substring 한 질의의 조각 키가 그 최종 질의와 일치하지 않는 다른 행의 등장 위치에도 적용될 수 있다. | **확실**, 구조 및 [L2] |
| salt 갱신이 관찰 키를 무효화하지 않음 | 고정 조각 키와 새 salt로 다시 도장을 계산할 수 있다. 저장 salt의 신선함과 이미 관찰된 검색 능력의 만료는 다르다. | **확실**, [L1], [L2] |
| 정규화 길이를 직접 저장 | 원문 byte 길이에 더해 정규화 문자 수가 추가된다. 여러 형식·작은 사전의 식별에 활용될 수 있다. QE equality 백서는 CBC의 블록 단위 길이 누출도 별도로 다루지만 이를 SealQL처럼 정확한 문자 수 노출과 같다고 보지 않는다. | 추가 채널 **확실**, 제품 간 공격률 차이 **모름**. [L2], [M2 §9.3][M2] |
| 공백 수 결합 채널 | 원문이 NFC 한글 음절(각3B)+ASCII 공백뿐이고 다른 정규화 변화가 없다면 `(암호문 바이트−29)−3×정규화 길이`가 공백 수다. 범용 문장에는 이 식을 적용할 수 없다. | 조건부 원리 **확실**, 이 역할의 자료별 정량은 **미측정**. 독립 길이 검토와 합쳐 판단. [L1] |
| 정답 count와 결과 행이 DB에 보임 | AWS/CipherSweet의 후보 수와 달리 정상 DB는 최종 일치 수를 안다. 동시에 우리는 적대적 DB의 참/거짓 판정과 count를 인증하지 않는다. | **확실**, [W1], [S1], [L1]. 모든 암호 방식에 관한 불가능성 주장 아님. |
| 형식적·외부 검증 수준 | 당사의 기계적 시험은 특정 공격의 실제 능력을 보여 준다. 제품 전체의 simulation-based 보안 증명이나 경쟁 제품과의 동등성 증명은 아니다. | 증거 범위 **확실**, 미시험 공격 최대치 **모름**. [L2], [QE 분석 범위][M2] |

기존 당사 시험에서 검색어 라벨·참조 사전과 1000개 질의를 준 공격은 후보-only 대비 위치 정보를 추가했을 때 전화 값 추측 0→87.48%, 주소 3.96→35.32%로 증가했다. 이는 **같은 시험의 위치 정보 추가 효과**이며 AWS·MongoDB 등 경쟁 제품의 복원율이 아니다. 익명 키-only 시험의 글자 정답률도 필드별 약9.7–34%였지만 사전·형식에 영향을 받으므로 일반 안전성 점수로 바꾸지 않는다. [공격 조건·대조·한계][L2]

T1에 보이는 위치 배열은 어느 조각인지 라벨이 없는 순열이다. 이것만으로 원문의 모든 문자 위치나 반복 조각이 바로 식별된다고 쓰지 않는다. T4에서 조각 키를 얻어 도장을 계산하는 추가 단계가 핵심이다. [L1], [L2]

MongoDB 관련 USENIX Security 2023 분석은 2022년 출시 QE와 실제 로그 표면의 결합을 공격했다. 현재 매뉴얼과 2024 백서는 로그/지속 접근의 한계를 명시한다. **옛 공격을 이유로 현재 모든 QE가 깨졌다고 하거나, 반대로 현재 snapshot 보장을 로그까지 안전하다는 뜻으로 쓰지 않는다.** [논문][P1], [현재 경계][M1], [백서 §7][M2]

## 6. 고객에게 쓸 수 있는 정확한 문장

다음은 이 조사에서 작성한 설명안이며 공급자의 문장을 인용한 것이 아니다.

> SealQL은 본문 암호화 키를 데이터베이스 밖에 두고, 검색용 토큰과 행마다 다른 도장으로 조건을 판정합니다. 검색 색인에는 토큰의 동일성·빈도·동시출현과 길이 정보가 남으므로, 키 없는 백업 유출에서도 통계적 추론을 막는다고 보장하지 않습니다.

근거: [현재 위협 모델][L1]. **확실**. “키가 없으면 값을 알아낼 수 없다”로 줄여 쓰면 의미가 달라진다.

> SealQL의 행별 salt는 저장된 도장을 다른 행의 도장과 바로 연결하기 어렵게 합니다. 다만 검색 중 DB에 전달되는 값·조각별 파생 키를 관찰하면 해당 값이나 조각의 위치·반복을 검사할 수 있습니다. 같은 키로 새로 저장한 행에도 이 검사가 가능하므로 검색 인자와 로그도 민감 정보로 관리해야 합니다.

근거: [관찰 및 수정 시험][L2]. **확실**. 루트·본문 키와 검색용 파생 키를 구분한 문장이다.

> SealQL은 정규화된 부분 문자열과 지원되는 LIKE 조건을 DB에서 판정하고 최종 count를 반환합니다. CipherStash의 Bloom match, AWS beacon, CipherSweet의 blind index처럼 오탐 후보를 만드는 구성과 기능이 다릅니다. 정확한 판정은 더 강한 기밀성을 뜻하지 않으며, SealQL이 이 제품들보다 전반적으로 안전하다고 입증된 것은 아닙니다.

근거: [제품 검수][L4], [EQL][C2], [AWS][W1], [CipherSweet][S1]. 기능 차이 **확실**, 전체 동등/우월 보안 **모름**. 도장 충돌과 악의적 DB의 거짓 count에 대한 §2 전제도 함께 제공한다.

> MongoDB Queryable Encryption의 동등·범위 검색은 정해진 DB 스냅샷 모델에서 빈도 노출을 숨기는 구조입니다. SealQL은 결정적 후보 토큰을 남기므로 그 보안 성질과 같다고 설명하지 않습니다. 두 제품 모두 백업만 유출된 상황과 검색 기록까지 유출된 상황을 구분해서 평가해야 합니다.

근거: [MongoDB 공식 경계][M1], [설계][M2], [당사][L1]. 구조 비교 **확실**. 문자열 미리보기까지 동일한 보장을 확장한 문장이 아니다.

| 피해야 할 표현 | 이유 |
|---|---|
| “AES-256을 쓰므로 검색 색인도 256비트 보안” | 본문 암호와 16비트 후보/64비트 도장 및 통계 누출은 다른 문제다. |
| “salt가 있으니 빈도·반복 누출이 없다” | 후보 토큰은 결정적이며, 관찰 조각 키는 위치/반복 검사에 재사용된다. |
| “아무 키도 DB에 보내지 않는다” | 루트·본문 키는 보내지 않지만 값/조각별 검색 파생 키는 보낸다. |
| “상용도 다 새므로 동급 또는 더 안전하다” | QE의 snapshot 모델, Bloom 후보 모델, enclave 신뢰 모델을 혼합한 주장이다. |
| “정확한 count라 DB 변조도 검출한다” | 결과 집합 완전성·판정 무결성은 보장하지 않는다. |
| “회사의 실제 데이터도 복원율 X% 이하” | 기존 수치는 제한된 로컬 fixture·공개 리뷰와 특정 공격자의 결과다. |

## 7. 기존 수집 자료에서 바로잡은 점 / 남은 모름

| 항목 | 이번 처리 |
|---|---|
| CipherStash v2 중심 설명 | 공식 현행 문서의 EQL3.0.4 기준으로 갱신. Bloom match와 일반 LIKE를 분리함. [C2] |
| AWS “equality뿐, 부분값 전혀 없음” | 임의 substring은 없지만 virtual field 부분값과 partitioning이 있음을 반영. [W2], [W3] |
| MongoDB QE를 결정적 HMAC equality 열과 동일시 | QE의 암호화 상태·태그와 CSFLE deterministic 모드를 분리. [M1] |
| 경쟁 substring을 모두 같은 의미로 취급 | EQL 순서 무시 match, Cloaked Search 분석기, MongoDB 미리보기, Acra prefix를 따로 기재. |
| exact count 지원만으로 기밀성 우열 결정 | 판정 정확도와 노출 정보를 별도 축으로 분리. |
| 다른 vault·마케팅형 “queryable” 제품 | 공개 색인 형식·T1/T4 누출이 부족한 제품은 순위표에서 제외. 배제는 안전/불안전 판정이 아님. |
| 미측정 | 경쟁 제품의 같은 데이터/질의/설정 공격률, 실배치 로그 구성, 모든 TEE 공격, MongoDB 문자열 미리보기의 상세 누출 증명. |

저장 형식 변경의 채택 결론은 내리지 않는다. 이번 조사에서 가장 분명한 검토 대상은 **T1의 결정적 후보 관계, T4의 재사용 가능한 위치 확인 능력, 정확한 길이의 결합 노출**이다. 이것을 줄이는 대안이 동일 질의 기능·정확 count·쓰기·10만 행 성능을 함께 만족하는지는 별도 기계적 검증이 필요하다. 기능이 줄어든 후보 검색이나 다른 신뢰 경계의 제품을 그대로 대체안으로 제시하지 않는다.

출처 목록·조회 날짜는 [sources.json](sources.json)에 있다. 공개 문서에 명시된 구조와 조건에 관한 비교이며 독립 제품 인증이 아니다. 당사 공격 수치는 로컬 fixture/말뭉치 결과이며 운영 보장·보안 인증이 아니다.

[L1]: ../../../../docs/threat-model.md
[L2]: ../../2026-09-29-attack-extra/report-ko.md
[L3]: ../../../../docs/current-state.md
[L4]: ../../2026-09-29-scale-count-million/report-ko.md
[C1]: https://cipherstash.com/docs/reference/eql/core-concepts
[C2]: https://cipherstash.com/docs/reference/eql/text
[C3]: https://cipherstash.com/docs/reference/eql/grouping-and-aggregates
[C4]: https://cipherstash.com/docs/concepts/searchable-encryption
[W1]: https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/searchable-encryption.html
[W2]: https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/beacons.html
[W3]: https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/using-beacons.html
[M1]: https://www.mongodb.com/docs/manual/core/queryable-encryption/features/
[M2]: https://cdn.bfldr.com/2URK6TO/as/64kp46t53v34xw37gkngbrg/An_Overview_of_Queryable_Encryption
[M3]: https://www.mongodb.com/docs/manual/core/queryable-encryption/fundamentals/encrypt-and-query/
[M4]: https://www.mongodb.com/docs/v8.2/reference/operator/aggregation/encStrContains/
[M5]: https://www.mongodb.com/docs/manual/core/queryable-encryption/reference/supported-operations/
[A1]: https://docs.cossacklabs.com/acra/security-controls/searchable-encryption/
[I1]: https://ironcorelabs.com/docs/cloaked-search/faq/
[I2]: https://ironcorelabs.com/docs/cloaked-search/configuration/token-filters/ngram/
[I3]: https://ironcorelabs.com/docs/cloaked-search/configuration/token-filters/edge-ngram/
[I4]: https://ironcorelabs.com/docs/cloaked-search/configuration/token-filters/reverse/
[S1]: https://ciphersweet.paragonie.com/security
[S2]: https://ciphersweet.paragonie.com/faq
[T1]: https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/always-encrypted-enclaves?view=sql-server-ver17
[P1]: https://www.usenix.org/conference/usenixsecurity23/presentation/gui
