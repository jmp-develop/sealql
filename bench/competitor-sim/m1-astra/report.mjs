import {readFileSync,writeFileSync} from 'node:fs';
const out='bench/results/2026-09-30-competitor-sim/m1-astra';
const d=JSON.parse(readFileSync(`${out}/results.json`)),v=JSON.parse(readFileSync(`${out}/verification.json`));
if(!d.complete||!v.passed)throw Error('Incomplete evidence');
const fields=['name','phone','address','memo','email','company'],labels={name:'이름',phone:'전화',address:'주소',memo:'메모',email:'이메일',company:'회사'},models=[...new Set(d.models.map(m=>m.id))];
const f=n=>n.toFixed(2),best=(field,model,known,channel='index')=>v.best.find(x=>x.field===field&&x.model===model&&x.known===known&&x.channel===channel);
const table=(headers,rows)=>[`| ${headers.join(' | ')} |`,`| ${headers.map(()=>'---').join(' | ')} |`,...rows.map(r=>`| ${r.join(' | ')} |`)].join('\n');
const pctTable=known=>table(['모델',...fields.map(x=>labels[x])],models.map(m=>[m,...fields.map(field=>f(best(field,m,known).pct))]));
const methods=table(['공격','공격자 입력·선택 규칙'],[
 ['group_frequency','같은 색인 전체 집합의 행 빈도를 참조의 공개 조각 집합 빈도와 비교해 최근접 값을 선택'],
 ['piece_frequency','조각별 로그 빈도 최솟값·중앙값·최댓값·평균과 토큰 수 차이로 참조 값을 순위화'],
 ['rank_frequency','관찰 색인군과 참조 값군을 빈도순으로 일대일 연결; 절단 충돌·빈도 동률에서 틀릴 수 있음'],
 ['known_projection','알려진 행의 양성 출현 교집합으로 조각→토큰 후보를 학습한 뒤 사전의 학습 조각 구성을 대조'],
 ['known_fingerprint','알려진 전체 색인 집합과 같으면 그 값의 알려진 빈도를 사용; 아니면 known_projection'],
 ['shared_known_dictionary','C 실험과 동일한 공통 알려진 행 서명·사전 공격; 비밀 토큰 생성자 없음'],
 ['shared_collision_phone','C와 같은 충돌 인지 전화 형식 조립; 알려진 관측과 양립하는 매핑을 보존, 모호/상한 도달 시 사전 공격으로 후퇴']]);
const baseline=table(['칸','참조 고유 정규화 값','A 사전 포함률 %','참조 분포 무작위 %','고유 원문 균등 무작위 %'],fields.map(field=>{const c=v.coverage.find(x=>x.field===field&&x.known===0);return [labels[field],c.referenceDistinct,f(c.covered/c.rows*100),...['random_empirical','random_distinct'].map(method=>f(d.baselines.find(x=>x.field===field&&x.known===0&&x.method===method).pct))];}));
const detail=table(['칸','모델','B5 맞힘/9,500','B5 대표 공격','그 공격의 글자 위치 맞힘 %'],fields.flatMap(field=>models.map(m=>{const r=best(field,m,500);return [labels[field],m,r.correct,r.method,f(r.characterPct)];})));
const sensitivity=table(['칸','알려진 행','S0 색인만 %','+원문 바이트 %','+정규화 글자 수 %'],fields.flatMap(field=>[0,100,500].map(known=>[labels[field],known,...['index','shared_bytes','s0_native'].map(ch=>f(best(field,'S0',known,ch).pct))])));
const externalSensitivity=table(['모델','칸','알려진 행','색인만 %','+원문 바이트 %'],v.best.filter(x=>x.channel==='shared_bytes'&&x.model!=='S0'&&x.correct>best(x.field,x.model,x.known).correct).map(x=>[x.model,labels[x.field],x.known,f(best(x.field,x.model,x.known).pct),f(x.pct)]));
const phones=d.results.filter(r=>r.field==='phone'&&r.channel==='index'&&r.method==='shared_collision_phone');
const phoneTable=table(['모델','알려진 행','맞힘/분모','복원 %','반환 값 수','2백만 상태 상한','매핑 열거 초과'],phones.map(r=>[r.model,r.known,`${r.correct}/${r.rows}`,f(r.pct),r.graphMetadata.returned,r.graphMetadata.capped,r.graphMetadata.overflow]));
const phoneSampleTable=table(['모델','알려진 행','무작위 표본 맞힘/500','표본 복원 %','Wilson 95% 구간 %','상태 상한 도달','고유 반환 중 오답','행당 상태 예산'],d.phoneSamples.map(s=>[s.model,s.known,`${s.correct}/500`,f(s.pct),s.wilson95.map(f).join('–'),s.capped,s.predictions.filter(p=>p.graphReturned&&!p.correct).length,s.graphMetadata.stateBudget??s.graphMetadata.maxStates??'공통 attacks.ts 참조']));
const awsBits=d.models.filter(x=>x.id==='AWS-standard').map(m=>`${labels[m.field]} ${m.metadata.bits}`).join(', ');
const text=`# 타 제품 색인 구조 비교 — A/B 공격 재현

## 범위와 먼저 읽을 한계

메모리에서 공식 색인 원시 연산을 재현한 **이 fixture·이 키·이 공격의 실측**이다. 외부 SDK 전체, 관리형 서비스, 키 관리, 운영 접근 통제를 침해한 결과가 아니다. 제품 코드·DB를 변경하거나 DB에 접속하지 않았다. 회사·주소는 반복 템플릿이며 실제 말뭉치 공격은 이번 범위에서 측정하지 않았다.

모든 입력은 앱이 먼저 SealQL과 같은 정규화(NFC, 전각 ASCII 변환, ASCII 소문자, 공백 제거)를 적용한다. **타사 기본 정규화라는 주장이 아니다.** 채점 대상은 정규화된 값 전체이며 원문 공백 복원과 다르다. 원문 완전 일치도 JSON의 rawCorrect로 별도 남겼다.

주 비교는 색인 토큰/비트만 제공한다. S0의 백업에는 추가 도장·salt·길이·위치 배열이 있지만 여기서는 길이 민감도만 추가했고 도장 순열 공격은 수행하지 않았다. 따라서 주 표는 전체 T1 누출의 상한이 아니다. 암호문 형식을 재현하지 않은 타사에 원문 바이트 길이를 실제로 노출한다고 주장하지 않는다.

## 결과

단위는 값 전체 복원율 %. 아래 주 표는 **전수 공격만** 비교하며, 계산 예산 때문에 표본으로 바꾼 Bloom 전화 강화 결과는 별도 표에 있다. 각 칸은 **이름 붙인 완결된 전수 공격들 중 집계 맞힘이 가장 높은 공격**이다. 동률이면 글자 위치 맞힘이 높은 공격을 표시한다. 행마다 정답을 보고 공격을 고르는 투표는 하지 않았다. 이는 사후 최댓값 비교이며 공격 선택용 별도 홀드아웃은 두지 않았다.

### A — 백업 색인 + 독립 참조 분포, 알려진 피해 원문 없음

${pctTable(0)}

### B1 — 피해 100행 원문을 알고 남은 9,900행만 채점

${pctTable(100)}

### B5 — 피해 500행 원문을 알고 남은 9,500행만 채점

${pctTable(500)}

전화는 사전에 없는 값을 형식으로 조립하므로 사전 공격과 구별해야 한다. 주소는 S0와 Bloom의 조각 공유를 이용한 알려진 원문 공격이 전체 값 일치 색인 공격보다 더 많은 값을 맞혔다. 회사는 작은 반복 도메인이라 알려진 원문이 늘면 여러 모델에서 높은 복원이 나타났다. 이를 단일 제품 전체의 보안 순위로 일반화할 수 없다.

### 전화 강한 공격의 분모와 중단 여부

${phoneTable}

열거 초과는 매핑 후보를 버리고 성공으로 세었다는 뜻이 아니다. 최신 공통 함수는 그 경우 후보별 가능한 토큰 배정과 전체 관측 토큰 설명 가능성을 검사한다. DFS는 두 해를 발견하면 모호로 판정하며 상태 상한에 닿으면 고유 복원으로 세지 않는다.

### Bloom 전화 강화 — 전수와 분리한 무작위 표본

${phoneSampleTable}

알려진 행을 제외한 모집단에서 seed=930500으로 조건별 500행을 비복원 추출했다. 공통 함수의 행당 상태 예산은 20,000이다. S0는 이미 완료한 2,000,000상태 전수 결과를 유지했으므로 두 전화 강화 결과는 계산 예산과 표본 크기가 같지 않다. 구간은 표본 전체 500행을 분모로 한 Wilson 이항 95% 근사 구간(유한 모집단 보정 미적용)이다. **구간은 이 고정 데이터에서 이 예산의 공격 맞힘률에 대한 표본 불확실성**이며 제품 보안이나 모든 공격의 복원 가능성에 대한 구간이 아니다. 상한 도달 행도 분모에 남기고 고유 복원으로 세지 않는다. 비교를 위해 공통 C의 Bloom 공격과 같은 행당 예산을 적용했다. Bloom의 충돌/자기충돌 처리는 휴리스틱이므로 고유 반환을 수학적 유일성 증명으로 부르지 않으며 반환 오답은 실패로 센다.

### 무작위 기준선과 사전 범위

${baseline}

피해·참조의 행 ID는 겹치지 않지만 반복 값은 겹칠 수 있다. 이름·메모·이메일 등의 사전 포함률이 0이면 사전에서 값을 고르는 공격의 값 복원율도 0일 수밖에 없다. **0%는 안전 증명이 아니다.** 이름·메모·이메일을 사전 밖에서 자유롭게 조립하는 강화 공격은 이번 A/B에서 구현하지 않았다. 글자 위치 맞힘에는 공통 접미사·하이픈·템플릿 추측도 포함되므로 암호 해독 글자 수라고 부르지 않는다.

### B5 대표 공격과 글자 지표

${detail}

## 같은 길이 보조정보를 준 민감도

shared_bytes는 원문 UTF-8 바이트 수를 모든 모델에 똑같이 추가 제공하는 통제 실험이다. 실제 타사 암호문 길이 노출 모델과 구분한다. s0_native는 S0에서 드러나는 정규화 글자 수까지 추가한다. 공통 dictionary/phone 공격은 길이를 사용하지 않으며 다른 공격들이 길이로 사전을 제한한다.

${sensitivity}

타사 색인에서 원문 바이트 수를 추가해 맞힘이 증가한 조합만 아래에 보인다. 나머지 조합은 증가가 없었으며 전체 결과는 JSON에 있다.

${externalSensitivity}

## 재현한 설정과 공식 근거

| 모델 | 이번 설정 | 지원 검색과 비교 한계 |
| --- | --- | --- |
| S0 | 실제 제품 토큰과 60회 대조, 부분16bit·정확 기본16bit/회사2bit | 정확·부분·앞끝·LIKE; 여기서는 결정적 색인 집합 사용 |
| AWS-standard | HMAC-SHA384 첫8바이트 오른쪽 b비트, 단일 partition; ${awsBits}bit | 정확 일치; 부분 검색 해당 없음; b=⌊log2(U_ref)−1⌋은 시작식 선택이며 편향 데이터의 권장 안전 구성 아님 |
| CipherSweet-FIPS-fast | PBKDF2-HMAC-SHA384 1회, 비밀 index key를 salt로, 출력8bit | 정확 일치; 변환 색인은 측정 안 함; 8bit는 실험 선택이며 제품 기본값 아님 |
| CipherStash-unique | 전체 값 HMAC-SHA256 256bit | 정확 일치; ordering 미사용 |
| CipherStash-match | 공통 전처리 후 소문자 Unicode 3gram, m2048/k6, HMAC-SHA256 digest의 UInt16LE(i×2)%2048 | Bloom 조각 집합 포함; LIKE/순서 판정과 다름, 2글자 검색 해당 없음 |
| Acra-CE-exact | 전체 값 HMAC-SHA256 256bit, 단일 ClientID에 대응하는 키 범위 | 정확 일치; 부분 검색 해당 없음 |

AWS의 비트 시작식과 균등 분포 전제는 [Beacon 길이 문서](https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/choosing-beacon-length.html), 원시 해시/표현은 [고정 버전 공식 Beacon 구현](https://github.com/aws/aws-database-encryption-sdk-dynamodb/blob/96d6132720b8014b8c28a051e3e7cd953d0c41bd/DynamoDbEncryption/dafny/DynamoDbEncryption/src/Beacon.dfy)을 따른다. SDK 키 파생을 대신한 독립 시뮬레이션 field key를 사용했다. 선택 항목인 AWS partition은 재현하지 않았다.

CipherSweet는 [blind index 원시 연산](https://ciphersweet.paragonie.com/internals/blind-index)과 [비트 설계 문서](https://ciphersweet.paragonie.com/php/blind-index-planning)를 근거로 FIPS-fast 8bit를 선택했다. Modern/Boring·slow 모드, 변환 색인 추가 구성과 구별한다.

CipherStash는 [EQL text 의미](https://cipherstash.com/docs/reference/eql/text), [Stack 고정 버전 match 기본 설정](https://github.com/cipherstash/stack/blob/6a92634498499705da3317b78c90820ca2985f37/packages/stack/src/schema/match-defaults.ts), [cipherstash-core 0.42.3 Bloom 소스](https://docs.rs/crate/cipherstash-core/0.42.3/source/src/bloom_filter.rs)를 따른다. 독립 모의 field key를 쓰므로 SDK 암호문/키 파생 호환 검증은 아니다. Acra는 [공식 searchable encryption 설명](https://docs.cossacklabs.com/acra/security-controls/searchable-encryption/)의 CE exact 구성을 사용했다.

## 공격과 검증

${methods}

최근접 빈도 공격은 전체 사전을 매번 스캔하지 않고 길이 조건에 맞는 사전에서 평균 빈도/군 빈도 최근접 81개와 최빈값을 비교하는 휴리스틱이다. 조각 학습은 알려진 행의 양성 출현 집합 포함관계를 이용한다. 평가자가 알고 있는 비밀 토큰 생성 함수는 mappingValidation의 학습 정확도 채점에만 쓰며 후보를 정정하거나 예측을 선택하는 데 쓰지 않는다.

seed=714029, 피해 첫10,000행·참조 다음10,000행, 알려진 행은 피해의 첫100/500행이다. 기존 fixture 재생 결과와 ID digest를 단언한다. 무작위 기준선은 칸별 고정 seed로 전체 피해에 대한 예측을 먼저 만든 뒤 알려진 행을 제외한다. 단일 seed/키이며 키별 분산·신뢰구간은 측정 안 함.

내부 검산은 ${v.aggregateRows}개 집계의 분모·중복 키, ${v.witnessChecks}개 표본 정답/ID, ${v.baselineChecks}개 무작위 기준선과 Bloom 강화 표본 1,000행의 seed·분모·채점을 확인했다. v-astra의 독립 예측 재실행 결과는 [독립 검산 JSON](../v-astra/verify-attacks-ab.json)을 참조한다. 이 보고서 자체 검산과 독립 검산을 구분한다. 연구 코드 TypeScript 검사와 문서 검사가 통과했다.

비전화5칸은 먼저 완료한 파일을 보존하고, 공통 전화 함수에 기본 동작이 같은 선택적 maxStates 인자를 추가한 뒤 전화만 재실행해 병합했다. merge.mjs는 두 부분의 모델 해시·행 ID digest와 비전화 공유 함수 구간의 바이트 해시가 같음을 단언한다. 결과의 mergedParts에 각 실행의 원래 공격 소스 해시·시각을 남겼다.

- [원시 집계·12개 고정 표본·예측 digest](results.json)
- [분모/채점 검산·대표 공격·사전 포함률·소스 해시](verification.json)
- [실행 코드](../../../competitor-sim/m1-astra/run.ts), [비밀 키 없는 공격자 함수](../../../competitor-sim/m1-astra/attacks.ts)
- [보존한 비전화 완료본](without-phone/results.json), [전화 전수·표본 완료본](phone/results.json), [병합 검증 코드](../../../competitor-sim/m1-astra/merge.mjs)

재실행: <code>rtk proxy node --max-old-space-size=4096 --import tsx bench/competitor-sim/m1-astra/run.ts</code> → <code>rtk proxy node --import tsx bench/competitor-sim/m1-astra/verify.ts</code> → <code>rtk proxy node bench/competitor-sim/m1-astra/report.mjs</code>. 제품 코드·DB 연결은 필요 없다. 부분 실행은 ONLY_FIELD/ONLY_MODEL 및 OUT_DIR로 별도 경로를 지정하고 전체 결과로 취급하지 않는다. 모델과 공통 공격 소스가 실행 중 바뀌면 완료 단언이 실패한다.

## 결론 3줄

1. 이 데이터에서 S0의 조각 공유는 알려진 원문으로 전화·주소를 복원하는 데 활용됐으며, 회사2bit만으로 전체 색인 누출을 설명할 수 없다.
2. 전체 값 exact 색인·Bloom·S0는 제공 기능과 누출 단위가 다르며, 이 표는 특정 설정·공격의 실측이지 제품 전체 보안 순위가 아니다.
3. 사전 밖 값의 0%, 단일 키 결과, 미구현 공격을 안전성으로 포장하지 않고 원시 분모·공격 이름·재생 코드를 함께 보존한다.
`;
writeFileSync(`${out}/report-ko.md`,text);console.log('Wrote '+out+'/report-ko.md');
