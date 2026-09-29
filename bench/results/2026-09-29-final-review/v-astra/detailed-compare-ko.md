# 검색 색인의 보안 경계: 대외 설명용 정밀 비교

조사일 2026-09-29. SealQL은 `7c14bda` 이후 현재 문서의 compact-only standard 구조를 기준으로 한다. 외부 제품은 공식 문서·공급자 공개 SDK·설계 논문 조사이며, 같은 데이터로 공격한 경쟁 실험이 아니다. 제품 코드와 DB는 변경하지 않았다. 기능 설명을 줄이고 T1·T2·T3·T4와 관찰 방어 장치에 집중했다.

**결론: SealQL의 보안상 장점은 본문 키를 DB 밖에 두는 것, 행·필드·scope 결속, 행별 salt로 도장의 직접 연결을 줄이는 것이다. 이것으로 검색 색인 전체가 상용 제품보다 강하거나 동등하다고 말할 수 없다.** 후보 토큰의 안정된 관계는 T1·T3에 남고, T4에서는 재사용 가능한 조각 키가 위치·반복까지 드러낸다. MongoDB QE의 제한된 스냅샷 빈도 은닉보다 약하며, 후보 집합만 드러내는 구성보다 관찰 정보가 세밀하다. 반면 다른 제품의 전체 값 결정적 태그와 비교하면 **정확 도장 하나의 행 간 연결**은 덜 직접적이다. 이 세 판단은 서로 다른 축이다. **확실:** [당사 구조][L1], [선택 원문 실험][L5], [관찰 실험][L2], [QE 경계][M1].

## 1. 읽는 기준과 공격자 경계

**확실**은 문서에 명시된 구조·지원·당사 실측의 해당 범위다. 공급자의 보안 주장은 독립적으로 입증됐다는 뜻이 아니다. **추정**은 공개 구조에서 도출한 공격 가능성이나 비교 판단으로, 동일 조건 실험은 없다. **모름**은 공개 자료 부족·버전 불명·미시험이다. 표의 제품명은 행 식별자이고, 모든 판단 칸에 확신과 근거를 붙였다. 문서에서 장치를 찾지 못한 경우에는 “없음” 대신 “모름”으로 썼다.

| 경계 | 공격자가 보는 것 / 제외하는 것 |
|---|---|
| T1 백업 1개 | **확실:** 키·검색 이력 없는 논리 저장물: 본문 암호문, 보조 색인, 행 관계·길이. 키까지 포함된 서버 이미지와 구분한다. [당사 정의][L1] |
| T2 시간축 | **확실:** T1 + 여러 시점의 저장물, WAL/복제 로그, 이전 행 버전·변경 시점. WAL이 자동으로 SQL bind 검색키까지 담는다는 뜻은 아니다. 당사 물리 WAL 공격은 미측정이다. [L1] |
| T3 알려진·선택 원문 | **확실:** T1 + 사전·참조 원문, 또는 정상 입력 경로로 자신이 선택한 값을 저장하고 그 저장 표현을 관찰. 같은 검색 키·scope에서의 삽입과 다른 scope 삽입은 다르다. [L5] |
| T4 질의 관찰 | **확실:** DB가 받은 질의 표현·토큰·파생 키, 접근 행·결과 크기·순서·반복. 검색어 원문 라벨까지 아는 경우는 별도다. 정상 TLS의 수동 패킷 감청과 DB 내부/종단 로그 관찰을 혼동하지 않는다. [L1], [MongoDB TLS 경계][M1] |
| 키·신뢰 경계 | **확실:** DB가 불신 대상인 구성에서도 앱·복호화 프록시·vault·enclave 등은 별도의 신뢰 대상이다. 이들 전부를 “서버” 하나로 묶으면 비교가 틀린다. [CipherStash][C5], [SQL enclave][Q2], [Evervault][E1] |

T1 덤프에 질의 로그가 같이 들어 있으면 이미 T4가 결합된 사건이다. 키 없는 추론은 AES를 깨는 공격이 아니다. 예컨대 같은 값을 가리키는 태그와 알려진 값의 대응만으로 필드를 맞힐 수 있다. **확실:** [선택 원문 시험][L5]. 또한 인증된 암호문 한 개와 결과 집합의 완전성은 다르다. SealQL은 반환 암호문 이동·변조를 검출하지만, 적대적 DB의 누락·거짓 count를 인증하지 않는다. **확실:** [L1].

## 2. 무엇을 어느 신뢰 영역에 두는가

본문 알고리즘은 경계 확인용으로만 적는다. 강한 본문 암호가 검색 색인의 빈도·접근 패턴까지 숨겨 주지는 않는다. `salt`라는 같은 단어도 셀별 무작위 salt, 필드별 비밀 키, 파티션 식별자를 구분해야 한다.

| 제품·구성 | 본문·키·신뢰 경계 | 검색 저장 구조와 분리 단위 |
|---|---|---|
| SealQL standard | **확실:** 앱 AES-256-GCM, 고정 루트/모델 키. DB에는 본문 키 대신 값·조각별 파생 키를 전달. AAD는 행·필드·scope 결속. [L1], [L3] | **확실:** 결정적 HMAC 절단 후보(조각 기본16비트, exact 설정2–32), 셀별16B salt와64비트 값/등장 도장, 정규화 길이·위치 순열. 현재 단어 경계 스트림은 제거됨. [L3] |
| CipherSweet | **확실:** 앱에서 인증 암호화. BoringCrypto는 XChaCha20+BLAKE2b MAC, FIPS backend는 다른 구성. master에서 필드·색인 키 분리; PK를 AAD로 쓰도록 권고. [S1], [S3] | **확실:** 설정한 비트 수의 결정적 blind index, keyed hash/KDF·transform. 무작위 본문과 별개로 검색 색인은 행 간 안정적이다. [S4] |
| CipherStash EQL / Proxy | **확실:** 앱 SDK 또는 Proxy가 AES-256-GCM-SIV 처리. ZeroKMS와 클라이언트의 분리된 키 재료; 실제 DEK는 앱/Proxy에서 사용. [C5] | **확실:** EQL의 `hm`은 전체 값 HMAC, `bf`는 Bloom 비트 집합; 선택한 ordering은 OPE/ORE 계열 추가 누출. `bf` 값은 문자 위치가 아니다. [C1], [C2] |
| Acra CE / EE | **확실:** AcraServer 프록시에서 암복호화. AcraStruct/AcraBlock은 AES-GCM 기반 봉투 암호; master/storage 키와 KMS 경계를 분리. [A2], [A3] | **확실:** 같은 ClientID의 값은 같은 HMAC-SHA256 검색 표현. EE prefix는 설정 길이별 태그를 추가하며 셀별 salt 위치 증명 방식이 아니다. [A1] |
| IronCore Cloaked Search | **확실:** 검색 프록시가 문서별 무작위 AES-256-GCM 키를 사용하고 tenant 비밀로 감싼다. standalone 또는 SaaS Shield 연동. [I1], [I5] | **확실:** tenant/index/field별 keyed token. 중복 제거·절단·순서 섞기와 분석기 설정. 필드별 salt/키를 SealQL의 셀별 salt와 동일시하지 않는다. [I1] |
| IronCore SaaS Shield 결정적 암호 | **확실:** 앱 SDK에서 AES-SIV, TSP/KMS는 tenant·경로별 키 파생을 지원. 일반 무작위 암호 모드와 구분한다. [I6], [I7] | **확실:** 동일 키·도메인의 동일 값이 같은 암호문. Cloaked Search의 절단 검색 토큰과는 별도 구성이다. [I6] |
| AWS Database Encryption SDK beacon | **확실:** 앱 SDK 인증 암호화, 검색은 KMS Hierarchical keyring을 요구. DB 서비스에 평문 키를 검색 인자로 전달하는 구조가 아니다. [W1], [W4] | **확실:** 절단 HMAC; 동일 파티션 내 결정적, 파티션 사이 태그 분리. 여러 파티션에 무작위 배치 가능; 질의는 fan-out. 셀별 위치 증명은 없다. [W2] |
| MongoDB QE 동등·범위 | **확실:** 클라이언트 인증 AES-CBC, 외부 KMS와 클라이언트 DEK. DB의 wrapped DEK와 실제 사용 키는 다르다. [M1], [M6] | **확실:** `__safeContent__` 검색 태그와 ESC/ECOC 암호화 상태. 같은 평문을 단일 결정적 태그로 묶는 열과 다르다. [M1], [백서 §3][M2] |
| MongoDB CSFLE deterministic | **확실:** 클라이언트 인증 AES-CBC; randomized 모드는 별도. 키는 클라이언트/KMS 경계. [M6], [M7] | **확실:** 같은 키·타입·값의 결정적 암호문으로 equality. QE의 상태형 색인 보장을 갖는 모드가 아니다. [M7] |
| SQL Server Always Encrypted 기본 | **확실:** 클라이언트 AES-CBC+HMAC, CMK는 DB 밖의 키 저장소, CEK는 클라이언트가 사용. [Q1], [Q3] | **확실:** deterministic 값의 암호문 동등 비교. randomized 기본 모드는 동등 검색도 제공하지 않는다. [Q1] |
| SQL Server + secure enclave | **확실:** 클라이언트가 CEK를 보안 채널로 enclave에 제공. enclave 안에서 평문 비교; 앱만 키를 쓰는 모델과 다르다. [Q2] | **확실:** randomized 열도 enclave 비교 가능. 해당 B-tree를 만들면 암호화 key가 **평문 순서**로 정렬된다. [Q4] |
| Baffle | **확실:** Basic의 결정적/무작위/FPE와 Advanced의 AES+SMPC는 다른 모드. Shield 프록시와 DB 연산부·SMPC 서비스의 분리 구조. [B1], [B2], [B3] | **모름:** Advanced의 정확한 태그 비트·salt·상태·누출 함수는 확인 자료에 미공개. Basic의 결정적 표현을 Advanced 전체에 대입하지 않는다. [B1], [B2] |
| Evervault | **확실:** SDK의 임시 ECDH+AES-256-GCM, E3 Nitro enclave 암호 서비스. 단순 앱 전용 로컬 키 모델과 다르다. [E1] | **확실:** 카드 재사용 판별 fingerprint가 별도 제공됨. **모름:** 범용 DB substring 색인 구조·누출 명세. 암호문과 fingerprint를 구분. [E2], [E3] |
| Skyflow | **확실:** vault의 polymorphic encryption/tokenization, managed/BYOK/BYOKMS 배포. 앱 DB의 토큰과 vault 원본 저장물은 다른 경계다. [Y1], [Y2] | **모름:** 내부 검색 표현의 알고리즘·비트·행별 salt. 랜덤/결정적/형식 보존 토큰 지원만으로 vault 색인 빈도 은닉을 증명할 수 없다. [Y1], [Y3] |
| Ubiq structured / EncryptForSearch | **확실:** 구조화 값은 FF1 형식 보존 암호, 비구조화는 AES-GCM 계열. SDK 환경에서 암복호화하고 키 서비스와 분리. [U1] | **확실:** EncryptForSearch는 동일 값에 대해 검색 가능한 키 버전들의 암호문을 반환. **추정:** 같은 dataset/key/tweak의 결정적 equality이며 행별 salt 증명 방식이 아님. [U2] |
| Piiano Vault | **확실:** 별도 vault REST 서비스/SDK 경계. **모름:** 확인 자료에서 서버 본문·검색 암호와 키 사용 위치의 충분한 명세. [V1], [V2] | **확실:** 공식 배포 SDK에 match/in/like 질의가 있음. **모름:** 그 질의를 실행하는 내부 색인·상태·누출 모델. [V2], [V3] |
| Google Tink deterministic AEAD | **확실:** 앱용 AES256-SIV 기본 primitive; 배포·DB 연결·키 정책은 통합자가 구성. 독립 검색 서버 제품은 아니다. [G1] | **확실:** 같은 키·AAD·원문이면 같은 암호문, 반복·길이 노출. 행마다 다른 AAD면 이 직접 동등 검색 전제가 달라진다. [G1] |

검색 의미는 한 줄로 제한한다. SealQL은 정규화 문자열을 DB 도장으로 판정한다. CipherSweet/AWS/Bloom 구성은 후보를 만들며, 결정적 equality 구성은 다른 제품에서도 DB 정확 비교가 가능하다. SQL enclave는 LIKE를, Skyflow는 LIKE·COUNT API를 제공하므로 **“다른 제품은 모두 앱에서 후보를 복호화해야 한다”는 설명은 틀리다.** Skyflow 내부 실행 위치와 Baffle의 세부 SQL 보안 계약은 별도 미확인이다. **확실:** [L3], [S2], [W1], [C2], [Q2], [Y4]; DB count 조합 일반화는 **추정**, 이번 외부 제품 실행 검증은 없다. MongoDB 문자열 기능은 조회한 공식 문서가 여전히 Public Preview로 설명하므로 아래 동등·범위의 보장을 자동 적용하지 않는다. **확실:** [M3].

## 3. T1 백업과 T3 알려진·선택 원문

“동치류”는 같은 저장 표현의 행 묶음이다. 원문을 모르는 T1도 묶음의 크기는 알 수 있다. 절단은 서로 다른 값을 같은 묶음에 넣지만, 여러 토큰·길이·필드의 결합까지 반드시 흐리지는 않는다. **확실:** [AWS 설명][W1], [CipherSweet 색인 경고][S5], [당사 공격][L5]. 모든 논리 덤프에서는 저장된 암호문·색인의 크기도 보인다고 가정한다. 그것이 정확한 원문 길이인지, 블록 단위 범위인지, padding된 상한인지는 구분하며 미공개 제품은 모름으로 남긴다. [L1], [Q3], [G1].

| 제품·구성 | T1: 드러나는 것 / 막는 것 | T3: 알려진·선택 원문으로 추가되는 것 |
|---|---|---|
| SealQL | **확실:** 후보 동일성·빈도·동시출현, 원문 byte 길이, 정규화 길이, 라벨 없는 위치 순열. salt는 도장끼리의 직접 연결을 줄이지만 후보 관계를 없애지 않는다. [L1] | **확실:** 같은 scope 삽입1000행 시험에서 제품의 정규화 전화 값95.1%, 주소81.9%, 회사100% 복원. 키·검색 관찰 없이 가능했다. 다른 scope 직접 라벨 전이는0이나 통계 추론 차단 증명은 아님. [L5] |
| CipherSweet | **확실:** 절단 blind-index 동치류·여러 transform의 교집합. 본문 랜덤화와 색인 누출은 별개. [S1], [S5] | **확실:** 정당한 사용자의 선택 원문도 공식 위협 모델에 포함. **추정:** 같은 키/색인의 알려진 후보 동치류에 라벨 부여 가능; 충돌과 입력 분포에 따라 성공률이 달라진다. [S1], [S4] |
| CipherStash | **확실:** equality 동일성·빈도, Bloom의 비트 동시출현, ordering을 켠 경우 순서. [C4] | **추정:** 전체 HMAC equality는 알려진 같은 값과 직접 연결. Bloom은 여러 삽입의 비트 조합을 학습할 표면이 남음; 동일 조건 복원율은 모름. [C1], [C2] |
| Acra | **확실:** 같은 ClientID의 전체 값 HMAC 동일성, prefix 구성에서는 길이별 동치류. [A1] | **추정:** 정상 입력한 값/접두어의 태그를 같은 ClientID 피해 데이터에 대응 가능. 키 없는 HMAC 역산이 아니라 알려진 입력의 라벨 전이다. [A1] |
| Cloaked Search | **확실:** 토큰의 문서 빈도·동시출현은 남음. 중복 제거·섞기는 문서 내부 반복 수·순서의 직접 노출을 줄임. [I1] | **추정:** 같은 tenant/index/field에서 알려진 입력의 토큰 조합을 연결 가능. 절단·분석기·혼합 토큰의 효과를 같은 공격으로 재지 않아 우열 모름. [I1], [I8] |
| SaaS Shield deterministic | **확실:** 같은 도메인의 값 동일성. 랜덤 문서 암호 모드와 다름. [I6] | **추정:** 같은 tenant·derivation path·키로 얻은 알려진 암호문은 그 값의 라벨이 된다. 다른 tenant에 자동 전이된다고 가정하지 않음. [I6], [I7] |
| AWS beacon | **확실:** 동일 파티션의 충돌 포함 동치류. 절단·분할은 큰 빈도 집단을 완화하며 완전 은닉과 다르다. [W2] | **추정:** 알려진 입력이 속한 파티션의 태그를 학습 가능. 무작위 분할이면 한 삽입만으로 모든 파티션 태그를 얻는 것은 아님. 상관 필드·편향 위험은 공식 경고. [W2], [W1] |
| MongoDB QE | **확실:** 완료 연산 사이 DB 스냅샷에서 값 동등·빈도 연결을 숨기는 목표. 문서 수·크기·비암호화 필드까지 숨기는 것은 아님. [설계 모델][M10] | **추정:** 알려진 한 행을 얻어도 결정적 equality 태그처럼 나머지 동일 값 전체를 즉시 묶을 수 없음. 질의 권한/관찰이 추가되면 다른 모델; 모든 선택 입력·부가정보 공격 차단은 모름. [M10], [백서 §5–6][M2] |
| MongoDB CSFLE deterministic | **확실:** 같은 암호문 동치류·빈도와 길이 관련 정보. randomized 모드에는 이 직접 동치류가 없음. [M7] | **추정:** 같은 키/타입으로 암호화한 알려진 값의 동치류를 연결. 작은 도메인·정상 암호화 API 접근이 위험을 키운다. [M7] |
| SQL AE 기본 deterministic | **확실:** 암호문 동일성·빈도. 랜덤화 기본 모드와 구분. [Q1] | **추정:** 동일 열 키/타입의 선택 원문 암호문을 피해 값과 비교 가능. 무작위화한 열에는 그대로 적용되지 않음. [Q1], [Q3] |
| SQL AE enclave randomized | **확실:** 결정적 값 동치류 대신, enclave용 색인이 있으면 평문 순서 누출. 일반 행 메타데이터도 별개. [Q4] | **추정:** 알려진 값·순위/분포와 색인 순서를 결합할 표면. 색인이 없는 구성까지 같은 누출이라고 할 수 없음. [Q4] |
| Baffle | **추정:** Basic deterministic/FPE는 모드에 따른 동일성·형식 누출. **모름:** Advanced SMPC의 저장물 빈도·동시출현·길이 누출 상한. [B1], [B2] | **모름:** Advanced의 선택 입력 누출 계약·공격 실측 미확인. 일반 SMPC 명칭만으로 입력/출력·접근 패턴까지 숨긴다고 평가하지 않음. [B2], [B3] |
| Evervault | **확실:** 본문은 매번 무작위 암호화하며 별도 fingerprint는 카드 재사용 연결용. **모름:** 길이 padding의 구체 보장. [E1], [E2] | **추정:** 저장한 같은 카드의 fingerprint를 아는 경우 연결 가능. 일반 필드에 임의 검색 가능한 색인을 준다고 확대하지 않음. [E2] |
| Skyflow | **추정:** 앱 DB의 결정적 토큰은 연결성을 가짐. **모름:** vault 내부 유출의 동치류·길이·빈도 계약; 앱 DB 토큰 탈취와 같은 사건이 아니다. [Y1], [Y3] | **모름:** vault 내부에 선택 입력을 대조할 때의 누출·복원율. API 권한으로 평문을 정상 반환받는 경우는 암호 색인 공격과 별개. [Y3], [Y4] |
| Ubiq structured | **확실:** 길이·형식이 보존됨. **추정:** 같은 dataset/key/tweak의 동일 값은 연결 가능하며 여러 칸·메타데이터와 결합될 수 있음. [U1], [U3] | **추정:** 동일 조건으로 얻은 알려진 암호문이 값의 라벨이 됨. 원문 도메인·키 버전·tweak를 맞추지 않은 직접 전이는 가정하지 않음. [U2], [U3] |
| Piiano Vault | **모름:** 공개 SDK의 질의 타입만으로 서버 T1 누출을 알 수 없음. 토큰화 API의 존재가 내부 색인 안전성 증명은 아님. [V1], [V2] | **모름:** 동일 입력의 서버 저장 표현·선택 입력 대응 여부. 클라이언트 검색 기능만 확인됨. [V2], [V3] |
| Tink deterministic AEAD | **확실:** 길이와 동일 key/AAD 아래 반복 노출. 무작위 AEAD와 다른 primitive. [G1] | **추정:** 동일 key/AAD의 알려진 암호문 라벨 전이. 사용자별 키/AAD 분리는 직접 연결 영역을 줄이지만 사전 지식을 없애지 않음. [G1] |

SealQL 시험의 95.1%는 1000개 피해 행, 별도 참조10000행, 같은 scope의 알려진 완전한 값1000개를 사용한 결과다. 임의 조각을 묶는 별도 전략은 전화95.9%였지만 자유 텍스트 입력을 허용한다고 가정했다. 둘 다 **정규화된 필드 전체 값**의 복원이며 원래 공백·대소문자나 여섯 필드 전체 레코드의 완전 복원을 뜻하지 않는다. 반대로 다른 필드0%도 안전 증명이 아니다. **확실:** [실험 조건·원시 결과][L5]. 정규화에는 NFC·전각 ASCII 변환·ASCII 소문자화·공백 제거가 포함된다. 정규화 길이와 byte 길이를 함께 공개하므로, NFC 한글 음절과 ASCII 공백만 있는 값은 `(암호문 byte−29)−3×정규화 길이`로 공백 수까지 계산할 수 있다. 이는 그 입력 조건에서만 성립하는 결합 채널이다. **확실:** [L1], [L3].

## 4. T2 시간축과 T4 검색 관찰

아래 시간축 분석은 공개 구조에서의 추론이 중심이다. 외부 제품의 실제 WAL·페이지·삭제 잔재를 수집하지 않았다. “갱신 때 암호문이 달라짐”과 “과거에 얻은 검색 능력이 미래 데이터에 적용되지 않음”은 다른 성질이다. 또한 삭제해도 공격자가 이미 복사한 백업은 지워지지 않는다. **확실:** 당사 관찰 키 재사용 [L1], [L2]; 외부에 대한 시간축 일반화는 각 칸의 **추정/모름**을 따른다.

| 제품·구성 | T2: WAL·다중 시점 | T4: DB·질의 종단 관찰 |
|---|---|---|
| SealQL | **추정:** 안정된 후보의 추가/삭제·행 연결을 전후 비교 가능. **확실:** 수정 salt가 달라도 고정 조각 키가 계속 유효. 물리 WAL 복원율은 모름. [L1], [L2] | **확실:** 관찰 값 키는 값 검사를, 조각 키는 같은 scope/필드의 과거·미래 행에서 해당 조각의 위치·반복 검사를 허용. 반복 질의·정답 수·접근 행도 노출. [L1], [L2] |
| CipherSweet | **추정:** 같은 키/색인 아래 stable blind index로 시점 간 동치류·변경 연결 가능. 본문 nonce가 이를 끊지 않음. WAL 실측은 모름. [S1], [S4] | **추정:** 반복 blind-index 질의·후보 집합 연결 가능. **확실:** 최종 후보 재확인은 앱 복호화 영역이므로 DB 후보 집합과 최종 정답 집합이 반드시 같지 않음. [S2] |
| CipherStash | **추정:** HMAC/Bloom·선택 ordering의 전후 차이가 남음. 매번 본문 DEK가 달라도 검색 표현의 결정성은 별개. [C1], [C5] | **추정:** equality/Bloom 질의·접근 집합 반복 연결. **확실:** DB에는 본문 복호화 키가 없지만 앱/Proxy에는 평문 경계가 존재. [C4], [C5] |
| Acra | **추정:** 동일 ClientID HMAC·prefix 슬롯의 시간축 변화가 관찰 가능. 키 교체 운영은 매 질의 은닉이 아님. [A1], [A3] | **추정:** DB가 받은 검색 HMAC과 동치류 연결. **확실:** AcraServer 프록시를 장악한 경우는 평문 처리 신뢰 영역의 침해로 모델이 커짐. [A1], [A2] |
| Cloaked Search | **추정:** 같은 tenant/index/field 토큰의 문서 증감을 연결. 문서 DEK와 토큰 순서를 바꾸어도 토큰 집합 관계는 남음. [I1], [I8] | **추정:** 암호화된 검색어도 반복 토큰·반환 후보·시간을 연결할 수 있음. **확실:** 중복/순서 억제 구성에는 SealQL형 문자 위치 확인 배열이 없음. [I1], [I9] |
| SaaS Shield deterministic | **추정:** 동일 tenant/path/key 암호문이 전후 값 연결을 제공. 키 버전 지원 자체를 갱신 은닉으로 볼 수 없음. [I6], [I7] | **추정:** 결정적 equality 요청·결과 연결. **확실:** TSP 키 정책은 키 사용 통제이지 DB 질의 반복 은닉 명세가 아님. [I6], [I7] |
| AWS beacon | **추정:** 같은 파티션 태그의 시간축 연결이 남음. 파티션 증가로 기존 태그나 유출 사본이 자동 무효화되지는 않음. [W2] | **추정:** partition별 반복 태그·fan-out·후보 수 관찰. **확실:** SDK가 복호화해 충돌 후보를 제거하므로 DB 관찰만으로 최종 필터 결과를 반드시 아는 것은 아님. [W1], [W2] |
| MongoDB QE | **확실:** 완료된 연산 사이 여러 DB 스냅샷의 보장을 명시. 그러나 oplog·profiler·plan cache 등 DBMS 전체 자료와 같은 모델이 아니며 백서는 별도 분석한다. [M1], [백서 §7–8][M2] | **확실:** snapshot+query transcript/log 또는 지속 접근은 보장 밖. 특히 range를 equality와 똑같이 평가하면 안 됨. **모름:** 현 문자열 미리보기까지 포함한 동일 공격률. [M1], [M3] |
| MongoDB CSFLE deterministic | **추정:** stable ciphertext로 시간축 값 연결. CBC 블록화가 이 연결을 막지 않음. [M7] | **추정:** 같은 암호문 검색·결과 동치류 연결. **확실:** QE의 스냅샷 빈도 은닉과 지속 관찰 방어를 가져올 수 없음. [M1], [M7] |
| SQL AE 기본 | **추정:** deterministic 열의 변경·동치류 연결. randomized 열은 동일 값 비교 신호를 줄이나 행 ID·갱신 이력까지 숨기지는 않음. [Q1], [Q3] | **추정:** deterministic 검색 인자와 일치 집합 연결. **확실:** 키 없는 DB 프로세스와 클라이언트 키/평문 프로세스를 분리. [Q1] |
| SQL AE enclave | **추정:** 버전·변경·색인 순서의 시간축 정보가 남을 수 있음; WAL 정량은 모름. **확실:** 복구 때도 enclave 키를 필요로 하는 색인 연산이 있음. [Q4] | **확실:** 비교 평문/CEK는 enclave 안에서 사용하고 외부 실행기에는 비교 결과가 돌아감. VBS는 host의 특권 계정 공격을 막지 않음; SGX의 신뢰 가정과 구분. [Q2], [Q5] |
| Baffle | **추정:** Basic deterministic의 시점 연결. **모름:** Advanced의 WAL·SMPC 상태·메시지 누출 상한. [B1], [B2] | **확실:** Advanced는 DB 연산과 별도 SMPC 구성요소를 사용한다고 설명. **모름:** 관찰자 범위·구성요소 공모·트래픽 패턴을 포함한 보안 명세. [B2], [B3] |
| Evervault | **추정:** 무작위 본문은 직접 equality 연결을 줄이나 저장 ID·갱신 시점·fingerprint는 별개. WAL 특화 보장은 모름. [E1], [E2] | **확실:** E3 enclave는 암호 처리 신뢰 영역을 격리. **모름:** 임의 DB 검색의 접근/결과 크기 은닉 기능. 사용자 앱/API 권한 침해는 별도다. [E1], [E3] |
| Skyflow | **모름:** vault 백업·복제 로그·시간축 내부 누출 명세. 앱 DB의 stable token 변경 연결은 **추정**이며 vault 원본 암호 분석과 다름. [Y1], [Y3] | **확실:** 공식 API는 질의 조건과 결과를 다룸. **모름:** 내부 저장소/서비스별로 누가 query pattern·volume을 보는지, 그 은닉의 공식 한계. [Y4], [Y5] |
| Ubiq structured | **추정:** 고정 dataset/key/tweak 암호문의 시점 연결. 키 버전이 늘어도 기존 백업의 정보가 지워지지 않으며 WAL 특화 보장은 모름. [U2], [U3] | **추정:** 같은 값의 검색 암호문 묶음·반환 집합 반복을 관찰 가능. **확실:** SDK의 키 사용 환경 침해와 DB만 침해를 구분해야 함. [U2], [U3] |
| Piiano Vault | **모름:** 서버 저장 형식·로그 보안 명세에 접근하지 못해 시간축 보장 판정 불가. [V1], [V2] | **추정:** REST 클라이언트와 vault API는 질의·결과 경계. **모름:** 그 안의 토큰/접근 은닉·복호화 위치. [V2], [V3] |
| Tink deterministic AEAD | **추정:** 고정 key/AAD의 암호문은 시점 간 동일 값 연결. DB 버전/로그 은닉을 제공하는 primitive가 아님. [G1] | **추정:** 같은 암호문을 검색 인자로 쓰면 반복이 보임. **확실:** 통신·DB 프로토콜은 Tink primitive 밖의 통합 책임. [G1] |

**MongoDB에 대한 좁고 중요한 구분:** “여러 백업이면 QE도 빈도가 바로 드러난다”는 결론은 공식 모델과 맞지 않는다. 반대로 “스냅샷 보장이 있으니 WAL까지 전부 안전하다”도 맞지 않는다. 백서는 oplog의 트랜잭션 번호·실패/동시 삽입과 빈도의 간접 상관까지 따로 다루며, 그 효과는 여러 변수에 의존한다고 설명한다. 이는 보장 범위를 나누라는 근거이지 현 제품 전체를 복원했다는 결과가 아니다. **확실:** [M1], [백서 §8.3][M2].

QE에도 상태 유지에 따른 누출 항목이 있다. 공식 문서는 compaction 사이에 삽입한 고유 field/value 수가 최악 조건에서 드러날 수 있다고 설명한다. 따라서 “빈도 은닉”을 모든 통계·시간축 정보의 은닉으로 읽지 않는다. **확실:** [compaction 경계][M8]. OST의 태그/카운터 구조는 클라이언트를 무상태로 만들기 위해 서버 쪽 암호화 구조에 필요한 정보를 두는 설계다. “클라이언트 stateless”와 “시스템에 상태가 없음”은 다르다. **확실:** [설계 §1.1·9][M10].

## 5. 관찰을 어렵게 하는 장치가 실제로 무엇인가

아래 “새 토큰”은 **같은 검색을 다시 해도 관찰자가 연결하기 어렵게 만드는 프로토콜**을 뜻한다. 무작위 본문 nonce, 매 행 새 도장, TLS 세션 키 변경과 다르다. “패딩”도 블록 암호의 필수 padding, 값 길이 숨김, 결과 개수 숨김을 구분한다. 특정 SQL 문자열을 암호화했다고 질의 빈도·결과 크기까지 숨겨지는 것은 아니다.

| 제품·구성 | 질의 난독화·매 질의 새 토큰 | 상태·분할·격리 장치 | 길이·결과 크기·접근 은닉 |
|---|---|---|---|
| SealQL | **확실: 없음.** 같은 scope/field의 값·조각 키 재사용. 인자 로그 금지와 TLS는 운영 조치. [L1] | **확실:** scope 분리·셀 salt는 있음. 은닉용 상태 카운터/enclave는 없음. [L3] | **확실: 없음.** 정규화 길이·위치 수, DB 최종 수/접근이 보임. 정답 count를 패딩한 숫자로 반환하지 않음. [L1], [L3] |
| CipherSweet | **추정:** blind-index 질의는 안정적; 독립 반복 은닉은 제공 구조에서 확인 못함. [S1], [S4] | **확실:** 절단·색인별 키·slow KDF. **모름:** 검색 은닉용 상태 카운터/TEE. [S1], [S4] | **확실:** 충돌 후보는 정답 집합을 흐릴 수 있음. **모름:** 일정 길이/일정 결과량 padding·ORAM의 제품 보장. [S2], [S5] |
| CipherStash | **추정:** stable HMAC/Bloom 표현의 반복 연결; 매 질의 비연결 토큰은 미확인. [C1], [C4] | **확실:** ZeroKMS 분리 키·정책과 TLS는 키 접근 경계. **모름:** 검색 상태 카운터 은닉. [C5] | **확실:** Bloom은 후보 오탐. **모름:** 길이/결과량 padding·접근 은닉. OPE/ORE 선택 시 순서는 오히려 추가됨. [C2], [C4] |
| Acra | **추정:** 암호화된 검색어를 HMAC로 치환해도 같은 ClientID 반복은 연결 가능. [A1] | **확실:** ClientID별 키·외부 키 관리. **모름:** 매 질의 상태 진화나 TEE 검색 보장. [A1], [A3] | **모름:** 일정 결과량·접근 패턴 은닉 보장. 암호문의 PKCS7 padding만으로는 길이 은닉이라고 못 함. [A2] |
| Cloaked Search | **확실:** 검색어를 keyed token으로 바꿈. **추정:** 본문 설명의 “cloaking”이 반복 패턴 은닉을 뜻하지는 않음. [I9], [I8] | **확실:** tenant/field/index별 키, 중복 제거·절단·토큰 순서 섞기. **모름:** 질의마다 상태 진화. [I1] | **확실:** 문서 내부 반복·순서의 직접 누출 완화. **모름:** 일정 결과량/트래픽 padding·ORAM. [I1], [I9] |
| SaaS Shield deterministic | **확실:** 결정적 암호문이므로 같은 조건의 새 비연결 토큰 아님. [I6] | **확실:** tenant KMS/TSP·키 정책. **모름:** 별도 질의 은닉 상태/TEE. [I7] | **모름:** 질의 결과 크기·접근 은닉. SDK 키 제어를 그 보장으로 바꾸지 않음. [I6], [I7] |
| AWS beacon | **확실:** 파티션별 안정된 beacon, N분할이면 N질의. 매 질의 난수 토큰과 다름. [W2] | **확실:** 절단+무작위/결정적 파티션 배치·KMS 계층 키. 일반 사용자 scope 분리와 다른 장치. [W2], [W4] | **확실:** 후보 충돌은 정답 수를 흐릴 수 있음. **모름:** 결과 수를 고정하는 padding/ORAM. fan-out은 그 자체로 은닉 증명 아님. [W1], [W2] |
| MongoDB QE | **확실:** 서버에 cryptographic query tokens를 보냄. **모름:** 매번 같은 질의의 비연결성 보장; 문서상 지속 관찰은 제외됨. [M1], [백서 §3][M2] | **확실:** ESC/ECOC 암호화 상태·태그/카운터 계열 구조·compaction. 삽입 태그를 분리하지만 관찰 키 만료를 보장하는 것은 아님. [M8], [M10] | **확실:** 백서는 민감한 길이에 앱 padding/고정길이 매핑을 권고하며 드라이버 내장 아님을 명시. 결과 수 은닉은 확인 못함(**모름**). [백서 §9.3][M2] |
| MongoDB CSFLE | **확실:** deterministic 검색의 반복 은닉 없음; randomized는 그 검색 대체 아님. [M7] | **확실:** KMS+클라이언트 키. QE 상태 카운터 구조가 아님. [M6], [M7] | **추정:** CBC 블록 단위 길이는 보이며 고정 크기 응답 의미 없음. **모름:** 별도 결과 padding. [M7], [M9] |
| SQL AE 기본 | **확실:** deterministic 인자 동등 비교; 매번 비연결로 바꾸는 검색 아님. [Q1] | **확실:** 외부 CMK·클라이언트 CEK. 기본 모드에는 검색 enclave 없음. [Q1] | **추정:** CBC 블록화는 길이를 거칠게 할 뿐 결과량 은닉 아님. **모름:** 결과/접근 padding. [Q3] |
| SQL AE enclave | **확실:** 보안 채널로 enclave 안에서 비교. **모름:** 반복/접근 패턴 전체 은닉 보장. [Q2] | **확실:** SGX/VBS 및 구성별 attestation. SGX는 host/guest, VBS는 VM 내부 공격 경계로 구분. [Q2], [Q5] | **확실:** 인덱스 순서·비교 결과는 외부에 보일 수 있음. **모름:** ORAM/고정 결과 크기. enclave 존재만으로 이를 인정하지 않음. [Q4] |
| Baffle Advanced | **모름:** SMPC 메시지가 매번 달라도 논리 질의·결과 연결까지 숨기는지 명세 미확인. [B2], [B3] | **확실:** SMPC 분리 실행 주장. **모름:** 비공모 가정·상태 카운터·정확한 구성요소별 누출. [B2], [B3] | **모름:** padding·더미 결과·ORAM·트래픽 분석 방어의 구체 보장. “암호문 연산” 주장으로 대체하지 않음. [B2] |
| Evervault | **모름:** 범용 검색 질의 난독화/새 토큰. 무작위 암호화 nonce와 별개. [E1], [E3] | **확실:** E3 Nitro enclave 격리·attestation을 통한 키 사용 통제. [E1] | **모름:** DB 검색 결과량·접근 패턴 padding. enclave 암호 서비스의 보호 범위를 넘어선 주장 불가. [E1], [E3] |
| Skyflow | **모름:** vault 내부 검색 토큰의 매 질의 비연결성. [Y3], [Y4] | **확실:** vault 분리·키 관리·권한 경계. **모름:** 공개 검증 가능한 검색 상태/TEE 명세. [Y1], [Y2] | **모름:** 내부 검색의 값 길이·결과량·접근 은닉 보장. API pagination은 padding 근거가 아님. [Y4], [Y5] |
| Ubiq structured | **확실:** 여러 키 버전용 검색 암호문을 생성. **추정:** 이것은 매 질의 새 비연결 토큰이 아님. [U2] | **확실:** 별도 키 관리·SDK 키 사용. **모름:** 검색 상태 카운터나 enclave를 통한 질의 은닉 보장. [U1], [U3] | **확실:** FPE는 길이·형식을 의도적으로 보존. **모름:** 결과 크기 padding·ORAM. [U1] |
| Piiano Vault | **모름:** SDK에서 서버 내부 질의 난독화 여부를 알 수 없음. [V2] | **확실:** 별도 vault 서비스. **모름:** 검색 상태/TEE/키 사용 경계의 세부 보장. [V1] | **모름:** padding·더미 질의·결과량 은닉. SDK의 pagination만 확인됨. [V3] |
| Tink deterministic AEAD | **확실:** 결정적 출력이므로 같은 key/AAD 반복 숨김 없음. [G1] | **확실:** 암호 primitive이며 검색 상태/TEE 프로토콜이 아님. [G1] | **확실:** 길이 누출을 명시. **모름:** 통합 앱이 별도로 넣는 padding/ORAM; primitive 성질로 주장 불가. [G1] |

이 표의 가장 큰 차이는 **은닉 장치의 대상**이다. AWS의 partitioning은 저장 빈도 집단을, Cloaked Search의 중복/순서 억제는 문서 내부 통계를, QE의 상태는 정해진 스냅샷 누출을, enclave는 실행 중 평문/키의 접근 경계를 다룬다. 서로 같은 방어가 아니고, 어느 하나도 자동으로 질의·결과 트래픽 전체를 숨긴다는 뜻이 아니다. **확실:** [W2], [I1], [M1], [Q2].

키 관리도 같은 구분이 필요하다. KMS가 master key를 보관해도 정상 앱/Proxy가 DEK 또는 파생 키를 받아 쓰면 그 실행 환경은 신뢰 대상이다. CipherStash의 split-key/ZeroKMS와 SaaS Shield의 TSP는 이 사용을 통제하는 경계이지, DB에 이미 보인 검색 표현을 지우는 장치가 아니다. **확실:** [C5], [I7]. SQL VBS의 HGS는 DB 호스트와 관리자 경계를 분리해야 하며, 같은 관리자가 양쪽을 통제하면 악성 환경을 승인할 수 있다는 공식 경고가 있다. **확실:** [Q5]. 따라서 SealQL의 “별도 KMS/enclave가 필수 아님”을 더 강한 키 보호라고 평가하지 않는다. [L3].

SealQL은 고정 키 설계로, 키를 바꾸려면 전체 재암호화·재색인이 필요하다. 다른 제품의 키 버전/회전·권한 정책은 운영 통제 측면의 차이지만, 공격자가 이미 확보한 오래된 암호문·태그·평문을 회수하는 기능은 아니다. **확실:** [당사 키 정책][L1], [Ubiq 다중 키 검색][U2], [Cloaked Search 회전][I8]; 기존 유출 사본에 관한 판단은 **추정**이다. 이번 비교는 키 수명 정책을 바꾸자는 제안이 아니다.

## 6. SealQL이 더 나은 곳·동등한 곳·약한 곳

비교 범위를 한정한 판정이다. “동등”은 아래 특정 성질이 같다는 뜻이며 보안 등급이나 실제 복원율의 동등성이 아니다.

| 비교 축·대상 | 판정과 대외 설명 한계 |
|---|---|
| 전체 값의 직접 행 간 동등 연결: EQL hm·Acra HMAC·결정적 CSFLE/AE/SIV | **확실 — 도장 단독 축에서 더 적게 노출:** SealQL의 salt 도장은 동일 값도 다르다. 하지만 후보·길이·substring을 함께 보면 전체 값 동치류를 추론할 수 있어 제품 전체 우월은 **모름**. [L1], [L5], [C1], [A1], [M7], [G1] |
| 원문 순서 노출: ordering을 켠 EQL / enclave B-tree | **확실 — 이 축에서 덜 노출:** SealQL은 암호화 값의 정렬/범위 기능을 제공하지 않으며 대응하는 값 순서 색인이 없다. 기능을 뺀 차이이지 같은 질의 보안 경쟁의 승리가 아님. [L3], [C4], [Q4] |
| 본문 키를 DB 밖에 유지: CipherSweet·Acra·EQL·AWS·CSFLE·QE 등 | **확실 — 같은 원칙:** 별도 신뢰 영역이 본문 키를 가진다. SealQL만의 우위가 아니며, 앱/프록시/KMS 구성은 각기 다름. [L1], [S1], [C5], [A2], [W1], [M6] |
| DB의 관찰 키로 위치·반복을 검사: 후보 집합형 구성 | **확실 — 더 세밀하게 노출:** SealQL T4 키는 조각 위치를 재검사한다. CipherSweet/AWS/Bloom 구성의 후보 태그보다 강한 검사 능력이다. 같은 기능/같은 복원율 비교는 **모름**. [L2], [S2], [W1], [C2] |
| T1·제한된 T2 빈도 은닉: QE 동등·범위 | **확실 — 약함:** 결정적 후보 관계가 남는 SealQL은 QE의 해당 스냅샷 성질과 같지 않음. QE의 persistent 모델 또는 문자열 미리보기까지 우열 확대 불가. [L1], [M1], [M3] |
| T3 같은 scope 선택 입력 | **확실 — 당사 취약성이 실측됨:** 알려진 후보 토큰으로 전화 전체 값95.1% 복원. 타사 복원율은 **모름**이므로 “상용도 같음” 또는 “salt로 해결” 불가. [L5] |
| 정확한 문자 수·길이 결합 | **확실 — 추가 누출:** SealQL은 byte 길이에 정규화 문자 수를 더 공개한다. exact-only 결정적 암호 구조에 같은 문자 수 열이 필수인 것은 아님. 모든 외부 배포의 길이 누출 우열은 **모름**. [L1], [G1], [백서 §9.3][M2] |
| 과거 검색 관찰 능력의 만료 | **확실 — 당사 방어 없음:** 새 salt/암호문에도 고정 조각 키가 유효. stable blind index 계열과 시간축 연결 위험은 같은 계열이나 강도는 **모름**. [L1], [S4], [A1] |
| 실행 중 키/평문 격리: SQL enclave·Evervault E3 | **확실 — 다른 신뢰 모델:** SealQL은 DB에 본문 키를 주지 않는 대신 검색키를 노출. enclave는 내부 평문 사용을 격리. host 종류·attestation·측면 채널을 같게 맞추지 않아 총 우열은 **모름**. [L1], [Q2], [E1] |
| CipherSweet/AWS의 후보 흐림 | **확실 — 같은 계열, 동급 미입증:** 절단 충돌을 사용한다는 공통점은 있으나 비트·분할·프로필 수·분포가 다름. SealQL의 최종 도장 판정은 정상 DB에 정답을 추가 공개. [L1], [S4], [W2] |
| Baffle Advanced·Skyflow·Piiano | **모름 — 순위 불가:** 내부 누출 명세 부족을 약함으로 채점하지 않음. 대외적으로 이들보다 안전하다고 할 근거가 없음. [B2], [Y3], [V2] |
| 증거 수준 | **확실 — 범위가 다름:** 당사는 특정 기계적 공격 증거, QE는 제한된 모델의 설계/분석을 제공. 공개 구현/문서량이나 유료 여부를 인증 점수로 바꾸지 않음. [L5], [M2], [P1] |

## 7. “DB·백업이 유출돼도 필드가 온전히 해독되지 않는다”의 판정

**그대로는 사용 불가다.** “해독”을 키로 본문 암호를 푸는 일만 뜻한다면 조건부 암호 성질을 설명할 수 있다. 고객이 이해하는 “값을 알아낼 수 없다”는 뜻이라면 당사 T3 시험에서 이미 개별 필드 전체 값 복원이 나왔다. 순수 T1에서도 작은 사전·길이·분포는 추론 근거가 되므로 보조 정보가 없다고 숨겨 전제하면 안 된다. **확실:** [L1], [L5].

사용할 수 있는 핵심 문장은 다음과 같다.

> SealQL은 본문 암호화 키를 DB 밖에서 관리하므로, 그 키와 앱의 복호화 권한이 함께 유출되지 않은 DB·백업 사본에서 본문 암호문을 직접 복호화하는 것을 막습니다. 다만 검색 색인의 빈도·동시출현·길이와 알려진 데이터를 결합하면 개별 필드 값을 추론할 수 있으며, 검색 기록까지 유출되면 관찰한 조각의 위치·반복도 확인할 수 있습니다.

**확실:** [L1], [L2], [L5]. 안전한 키 생성·관리, 지원 암호 사용량/nonce 조건, 앱과 DB의 권한 분리, 실제 저장 형식/설정 준수가 전제다. 이는 “전체 필드/레코드 복원 불가”라는 보장이 아니다. 로그 제외를 선언하는 것만으로 실제 APM·프록시·실패 인자 유출이 사라지는 것도 아니다. [L1].

## 8. 대외용 보안 문장 7개

각 문장은 제한 문장까지 함께 사용한다. 공격 수치를 마케팅 안전성 점수로 사용하지 않는다.

| 사용할 문장 | 확신·근거 |
|---|---|
| “SealQL은 선택한 필드의 본문을 앱에서 암호화하고 행·필드·검색 범위에 결속합니다. DB에는 본문 키를 보내지 않지만, 검색 때 값·조각별 파생 키를 보냅니다.” | **확실:** [위협 모델][L1], [현재 구조][L3]. “어떤 키도 보내지 않는다”로 줄이지 않음. |
| “행마다 다른 salt는 저장 도장을 바로 대조해 같은 값·조각을 연결하는 것을 줄입니다. 후보 토큰의 빈도·동시출현과 길이 정보까지 숨기는 기능은 아닙니다.” | **확실:** [저장 구조][L1], [선택 원문 시험][L5]. |
| “같은 검색 범위에 알려진 값을 입력하고 색인을 읽을 수 있는 공격자는 검색키 없이도 필드 값을 추론할 수 있습니다. 쓰기 권한과 검색 범위 분리는 중요하지만, 그 자체가 통계적 추론을 막는 보장은 아닙니다.” | **확실:** [선택 원문·다른 scope 대조][L5]. |
| “검색 인자와 로그도 민감 정보입니다. 관찰한 조각 키는 해당 검색 범위에서 그 조각의 위치와 반복을 확인하는 데 재사용될 수 있고, 이후 수정한 행에도 유효합니다.” | **확실:** [검색 관찰 시험][L2], [운영 경계][L1]. |
| “SealQL의 결정적 후보 색인은 MongoDB Queryable Encryption의 동등·범위 검색이 목표로 하는 스냅샷 빈도 은닉과 다릅니다. 두 제품 모두 백업만 유출된 상황과 검색 기록까지 노출된 상황을 나누어 평가해야 합니다.” | **확실:** [당사][L1], [MongoDB 공식 모델][M1]. 문자열 미리보기에는 이 비교를 자동 적용하지 않음. |
| “SealQL의 DB 판정과 정확한 count는 후보를 앱으로 가져와 재확인하는 작업을 줄입니다. 이는 검색 기능·실행 위치의 차이이며, 다른 검색 암호 제품보다 기밀성이 강하다는 뜻은 아닙니다.” | **확실:** [제품 동작][L3], [AWS 후보 재확인][W1], [CipherSweet][S2]. 도장 충돌·적대적 DB 판정 한계는 [L1]. |
| “TLS·키 관리·검색 색인 보호는 서로 다른 보호입니다. TLS는 전송 구간을 보호하지만 DB 종단이 받은 검색 표현을 숨기지 않으며, enclave의 보호도 종류와 검증 구성에 따라 달라집니다.” | **확실:** [TLS 경계][M1], [enclave 경계][Q2]. 특정 타사 전체 안전성을 단정하지 않음. |

## 9. 남은 모름과 출처 적용 범위

- **확실:** 이번 비교는 공식 자료와 기존 당사 실측이다. 외부 제품 설치·공격·WAL 채집, 같은 데이터/설정의 복원율 비교는 하지 않았다. 제품 전체 보안 인증도 아니다. [당사 시험 범위][L5].
- **모름:** Baffle Advanced·Skyflow·Piiano의 내부 검색 누출 함수, 모든 제품의 실제 배포 로그/패딩 구성. 공급자에게 T1/T2/T3/T4별 누출 명세와 관찰자 경계가 필요하다. [B2], [Y3], [V2].
- **확실:** Piiano 문서 사이트는 조사 중 접근 실패했다. 공식 GitHub와 공급자 배포 `@piiano/vault-client@1.1.11`의 타입을 확인했다. 이는 SDK 버전의 증거이며 현재 서버 전체 기능·서비스 상태의 증거가 아니다. [V1], [V2], [V3].
- **확실:** EQL은 현행 문서 v3 계열, MongoDB 문자열은 조회한 문서의 Public Preview 경고를 따른다. 과거 QE 공격 논문은 2022년 구현/로그 분석이며 현 제품 전체 붕괴의 근거로 쓰지 않았다. [C1], [M3], [P1].
- **확실:** 배포·과금은 보안 순위가 아니다. SDK·프록시·vault·전용 DB·TEE의 구분은 §2의 신뢰 경계에 반영했다. 이번 추가 지시대로 라이선스/기능 행렬은 확장하지 않았다. [C5], [Q2], [Y2].

출처와 문서 검사는 [detailed-sources.json](detailed-sources.json), [detailed-verification.json](detailed-verification.json)에 기록한다. 기존 [간단 비교](report-ko.md)는 이전 조사 결과로 보존한다. 저장 형식 변경이나 새 보안 정책 채택을 권고한 보고서는 아니다.

[L1]: ../../../../docs/threat-model.md
[L2]: ../../2026-09-29-attack-extra/report-ko.md
[L3]: ../../../../docs/current-state.md
[L5]: ../r9-impl/report-ko.md
[S1]: https://ciphersweet.paragonie.com/security
[S2]: https://ciphersweet.paragonie.com/faq
[S3]: https://ciphersweet.paragonie.com/internals/encryption
[S4]: https://ciphersweet.paragonie.com/internals/blind-index
[S5]: https://ciphersweet.paragonie.com/php
[C1]: https://cipherstash.com/docs/reference/eql/core-concepts
[C2]: https://cipherstash.com/docs/reference/eql/text
[C4]: https://cipherstash.com/docs/concepts/searchable-encryption
[C5]: https://cipherstash.com/docs/security/cryptography
[A1]: https://docs.cossacklabs.com/acra/security-controls/searchable-encryption/
[A2]: https://docs.cossacklabs.com/acra/acra-in-depth/cryptography-and-key-management/
[A3]: https://docs.cossacklabs.com/acra/security-controls/key-management/inventory/
[I1]: https://ironcorelabs.com/docs/cloaked-search/faq/
[I5]: https://ironcorelabs.com/docs/cloaked-search/deploying/
[I6]: https://ironcorelabs.com/docs/saas-shield/deterministic-encryption/
[I7]: https://ironcorelabs.com/docs/saas-shield/tenant-security-client/overview/
[I8]: https://ironcorelabs.com/docs/cloaked-search/configuration/overview/
[I9]: https://ironcorelabs.com/docs/cloaked-search/
[W1]: https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/searchable-encryption.html
[W2]: https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/beacons.html
[W4]: https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/configure-beacons.html
[M1]: https://www.mongodb.com/docs/manual/core/queryable-encryption/features/
[M2]: https://cdn.bfldr.com/2URK6TO/as/64kp46t53v34xw37gkngbrg/An_Overview_of_Queryable_Encryption
[M3]: https://www.mongodb.com/docs/manual/core/queryable-encryption/fundamentals/encrypt-and-query/
[M6]: https://www.mongodb.com/docs/manual/core/queryable-encryption/about-qe-csfle/
[M7]: https://www.mongodb.com/docs/manual/core/csfle/fundamentals/encryption-algorithms/
[M8]: https://www.mongodb.com/docs/manual/core/queryable-encryption/fundamentals/manage-collections/
[M9]: https://www.mongodb.com/docs/manual/core/csfle/reference/cryptographic-primitives/
[M10]: https://cdn.bfldr.com/2URK6TO/as/jkwp857q2zr8fj5vqs24f5/Design__Analysis_Stateless_Document_Database_Encryption_Scheme
[Q1]: https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/always-encrypted-database-engine?view=sql-server-ver17
[Q2]: https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/always-encrypted-enclaves?view=sql-server-ver17
[Q3]: https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/always-encrypted-cryptography?view=sql-server-ver17
[Q4]: https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/always-encrypted-enclaves-create-use-indexes?view=sql-server-ver17
[Q5]: https://learn.microsoft.com/en-us/sql/relational-databases/security/encryption/always-encrypted-enclaves-host-guardian-service-plan?view=sql-server-ver17
[B1]: https://baffle.io/supported-encryption-modes/
[B2]: https://baffle.io/technology/advanced-encryption/
[B3]: https://baffle.io/simplified-encryption/
[E1]: https://docs.evervault.com/developers/evervault-encryption
[E2]: https://docs.evervault.com/fingerprint
[E3]: https://docs.evervault.com/api
[Y1]: https://docs.skyflow.com/docs/fundamentals/product-overview
[Y2]: https://docs.skyflow.com/docs/fundamentals/deployment-models
[Y3]: https://www.skyflow.com/post/what-is-polymorphic-encryption
[Y4]: https://docs.skyflow.com/api/data/query/execute-query
[Y5]: https://docs.skyflow.com/docs/fundamentals/explore-skyflow
[U1]: https://dev.ubiqsecurity.com/docs/faq
[U2]: https://dev.ubiqsecurity.com/docs/go-library
[U3]: https://dev.ubiqsecurity.com/docs/security-at-ubiq
[V1]: https://github.com/piiano/vault-typescript
[V2]: https://unpkg.com/@piiano/vault-client@1.1.11/dist/generated/models/Query.d.ts
[V3]: https://unpkg.com/@piiano/vault-client@1.1.11/dist/generated/services/ObjectsClient.d.ts
[G1]: https://developers.google.com/tink/deterministic-aead?hl=en
[P1]: https://www.usenix.org/conference/usenixsecurity23/presentation/gui
