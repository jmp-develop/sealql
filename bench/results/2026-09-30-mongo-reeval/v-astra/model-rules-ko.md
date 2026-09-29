# C-mongo 재현 규칙과 공격자 관찰 경계

2026-09-30. 공식 문서·소스 대조이며 제품 구현 또는 MongoDB SDK 완전 재현 인증이 아니다. C-port는 과거 PostgreSQL 연구 형식, C-mongo는 아래 관찰 정보를 보존하는 메모리 모형이다.

| 항목 | C-port | C-mongo 필수 규칙 | 근거 |
|---|---|---|---|
| 본문과 행별 검색 꼬리표 | 값 토큰과 등장순번의 해시 | 본문 무작위 인증암호화, EDC 꼬리표는 값별 키와 카운터에서 PRF 파생. 서로 다른 등장의 꼬리표를 같은 값이라는 이유로 직접 연결하지 않는다 | [기술 개요 §3](https://cdn.bfldr.com/2URK6TO/as/64kp46t53v34xw37gkngbrg/An_Overview_of_Queryable_Encryption) |
| ESC | 결정적 장부 ID와 **평문 n** | ESC ID는 별도 키의 PRF, 값은 암호화된 카운터. EDC와 ESC를 같은 PRF 출력으로 만들거나 공개 연결표를 제공하지 않는다 | [USENIX23 §2](https://www.usenix.org/system/files/usenixsecurity23-gui_1.pdf) |
| ECOC | 이식안에 따라 생략 | 암호화된 압축용 상태. 단일 백업만으로 평문 값 토큰이나 ESC 연결을 복호화할 수 없다 | [기술 개요 §3](https://cdn.bfldr.com/2URK6TO/as/64kp46t53v34xw37gkngbrg/An_Overview_of_Queryable_Encryption) |
| 압축 전 | 장부별 빈도 공개 | equality 필드의 삽입·갱신마다 ESC/ECOC 문서 추가. 문서 총수는 보이지만 값별 그룹·빈도는 자동으로 보이지 않는다 | [공식 관리 문서](https://www.mongodb.com/docs/manual/core/queryable-encryption/fundamentals/manage-collections/) |
| 압축 후 | 평문 n 유지 여부 명시 | ECOC 비우기, ESC 감소. 최악에는 지난 압축 이후 서로 다른 필드/값 쌍의 **개수** 누출. 각 값의 빈도·평문·행 연결표까지 공개되는 것으로 확대하지 않는다 | [공식 관리 문서](https://www.mongodb.com/docs/manual/core/queryable-encryption/fundamentals/manage-collections/) |
| contention | 원 실험 partition 설정 기록 | 기술 개요 기본 cf=8이면 u=0..8, 총 9개 버킷. 조회는 모든 버킷을 확인한다. 질의마다 새 독립 검색어 토큰이라는 뜻이 아니다 | [기술 개요 §9.2](https://cdn.bfldr.com/2URK6TO/as/64kp46t53v34xw37gkngbrg/An_Overview_of_Queryable_Encryption) |
| substring | 원 연구 2..10 조각 | 소스는 실제 부분 문자열을 중복 제거. B=원문 UTF-8 바이트 수, E=16 floor((B+5+16)/16), P=min(설정 최대 글자수,E−5), M=Σ(j=minQuery..min(maxQuery,P))(P−j+1). 실제 조각 수를 M까지 가짜 조각으로 채운다. exact 1개도 별도 포함한다 | [공식 인코더 generate_substring_tree](https://raw.githubusercontent.com/mongodb/libmongocrypt/3872fc2ad0d1c712d43aaa26eefb49da64e61a62/src/mc-text-search-str-encode.c) |
| 길이와 순서 | 원 형식 노출 그대로 | 원문의 정확한 글자 수를 별도 공개하지 않는다. 암호문은 바이트 길이 블록 구간을 드러낸다. 가짜 조각 여부를명시하는 별도 라벨은 주지 않는다. 아래 추가 확인처럼 실제 배열 순서는 존재하므로 unordered 근사의 한계를 적는다 | [공식 인코더](https://raw.githubusercontent.com/mongodb/libmongocrypt/3872fc2ad0d1c712d43aaa26eefb49da64e61a62/src/mc-text-search-str-encode.c), [기술 개요 §9.3](https://cdn.bfldr.com/2URK6TO/as/64kp46t53v34xw37gkngbrg/An_Overview_of_Queryable_Encryption) |

## 공격별 제공 정보

| 채널 | 제공 | 제공하면 안 되는 정보 / 별도 강한 채널 |
|---|---|---|
| A 백업 / B 알려진 원문 | 저장된 EDC/ESC/ECOC, 형태·길이, B에서 선택된 피해 행의 원문 | 키, 카운터 복호화, 평문 조각↔ESC 키 매핑, 내부 생성 순서 |
| C 선택 삽입 후 단일 백업 | 선택한 원문과 그 삽입 행, 최종 저장 상태 | 삽입 요청의 서버용 값 토큰을 API 호출자가 당연히 안다고 가정하지 않는다 |
| C 삽입 전후 두 백업 | 두 저장 상태의 차집합, 새 행·새 ESC/ECOC 문서 집합 | 한 삽입 안의 각 조각↔새 ESC 문서 매핑은 별도 증거 없으면 숨긴다. 여러 건 일괄 변화와 한 건씩 관찰을 구분한다 |
| D 질의 관찰 | 서버가 실제 받는 검색 토큰, 접근/결과 집합; 검색어 앎/모름 별도 | TLS 암호문만 감청한 경우와 같지 않다. 클라이언트 키는 제공하지 않는다 |
| 압축 로그 / WAL | 로그가 실제 노출하는 트랜잭션별 ESC 그룹과 변경 이력 | 깨끗한 전후 스냅샷에 이러한 그룹 경계를 임의 추가하지 않는다 |

[공식 보안 경계](https://www.mongodb.com/docs/manual/core/queryable-encryption/features/)는 완료된 연산 사이 DB 스냅샷과 지속적인 DB/질의 관찰을 구분한다. [USENIX23 공격](https://www.usenix.org/system/files/usenixsecurity23-gui_1.pdf)은 queryLog·opLog를 통한 연결을 다루며, 논문의 MongoDB 6.x 계열과 현재 substring preview는 같은 버전이 아니다. 여기서 로그 공격을 구현하면 그 채널의 재현이며 최신 버전 취약성 검증으로 표현하지 않는다.

## 반드시 명시할 재현 한계

- **추가 소스 확인:** [서버 r8.2.0 fle_crypto.cpp L3582–3621,1247–1249,3687–3689](https://github.com/mongodb/mongo/blob/r8.2.0/src/mongo/crypto/fle_crypto.cpp)은 exact→substring 태그 순서를 보존해 배열에 쓴다. [클라이언트 marking.c substring token 생성](https://github.com/mongodb/libmongocrypt/blob/3872fc2ad0d1c712d43aaa26eefb49da64e61a62/src/mongocrypt-marking.c)는 문자열 hashset 순서와 마지막 fake 반복을 append한다. 이번 모형이 태그를 집합으로 취급하면 BSON 순서 채널은 빠진다. D에서 알려진 태그의 rank와 공개 FNV 순서를 결합하는 추가 공격 가능성은 미측정이며, 이번 복원율을 실제 MongoDB의 상한으로 부르지 않는다. 원문 위치 순서를 임의로 추가하는 것 역시 잘못이다.
- 가짜 조각은 매번 독립적인 문자열이 아니다. [문자열 집합 소스 fake 문자열·iterator](https://raw.githubusercontent.com/mongodb/libmongocrypt/3872fc2ad0d1c712d43aaa26eefb49da64e61a62/src/mc-str-encode-string-sets.c)에 따르면 원문 뒤 0xFF를 붙인 하나의 값에 남은 패딩 개수를 multiplicity로 부여한다. 등장별 꼬리표는 다르지만 압축 고유 그룹 수를 계산할 때 이 관계를 보존한다.
- substring 설정의 내부 exact 꼬리표 1개와 공개 equality 질의 지원은 구분한다. 최대 60글자 설정을 넘는 입력은 잘라내거나 자동 확장하지 않고 미지원 수와 분모를 기록한다.
- 2024 기술 개요의 OST 분석과 2023 논문을 최신 substring 전체의 보안 증명으로 인용하지 않는다.
- 소스 revision과 SHA-256은 [source-provenance.json](source-provenance.json)에 고정했다. 실행 모델은 위 수식을 고정하고 모델 해시도 남긴다.
- 메모리 모형에서 암호문을 불투명 표식으로 대체할 수 있으나 길이·갱신·연결 가능성은 보존해야 한다. SDK 바이트 형식, 실제 서버 로그, 장애 복구·동시성은 별도 검증이다.
- C-port 평문 장부의 빈도 회복을 C-mongo 암호화 장부 결과에 합산하지 않는다. 모형의 0% 복원은 공격 실패이지 보안 증명이 아니다.
