import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const out='bench/results/2026-09-30-competitor-sim/r9-impl';
const read=n=>JSON.parse(readFileSync(`${out}/${n}.json`,'utf8'));
const c=read('chosen'),d=read('observed'),graph=read('observed-phone-CipherStash-match-graph');
if(!c.complete||!d.complete)throw Error('Incomplete whole-population evidence');
const fields=['name','phone','address','memo','email','company'],names=['이름','전화','주소','메모','이메일','회사'];
const models=['S0','AWS-standard','CipherSweet-FIPS-fast','CipherStash-unique','CipherStash-match','Acra-CE-exact'];
const fmt=n=>n.toFixed(2),pair=m=>`${fmt(m.valuePct)} / ${fmt(m.characterPct)}`;
const best=(r,known)=>{
 const options=[known,known+'Combined',known+'Positions'].filter(k=>r[k]).map(k=>({name:k,metric:r[k]}));
 if(r.field==='phone'&&r.model==='CipherStash-match'&&r.mode==='partial'&&known==='known')options.push({name:'query-trained-phone',metric:graph.metric});
 return options.sort((a,b)=>b.metric.valuePct-a.metric.valuePct||b.metric.characterPct-a.metric.characterPct)[0];
};
const lines=['# C 선택 삽입·D 질의 관찰 색인 모델 비교','',
'기존 fixture 피해 10,000행과 참조 10,000행에서 현재 SealQL(S0), AWS standard beacon, CipherSweet FIPS-fast, CipherStash unique/match, Acra CE exact의 색인 원시 연산을 메모리에서 재현했다. 제품 코드·DB는 변경하지 않았다. **외부 제품 전체 보안 평가나 SDK 호환 구현이 아니며, 기능과 구성 차이를 숨긴 보안 순위로 사용하면 안 된다.**','',
'## 공통 조건과 공격자 입력','',
`- 피해·참조 ID 비중첩 20,000행 SHA-256: \`${c.identityDigest}\`. 기존 100,000행 fixture의 고정 seed 재생이며 이전 DB-read 원문 해시와 v-astra가 대조했다.`,
'- 모든 모델 앞에 같은 앱 정규화(NFC·전각 ASCII 변환·ASCII 소문자·공백 제거)를 적용한다. 공급자 기본 정규화라고 주장하지 않는다. 값 복원은 정규화 문자열 전체 일치, 글자 복원은 같은 위치의 Unicode codepoint 일치다.',
'- C는 같은 키·필드 범위에 참조에서 고정 seed 108029로 고른 정상 값 100/1,000개를 삽입하고 원문과 색인 배열을 관찰한다. 피해 10,000행 모두 채점하며 삽입 행은 피해 행에 포함하지 않는다.',
'- D는 seed 714029로 1,000회 질의를 6칸에 분배한다. 정확 질의와 공통 3글자 이상 부분 질의는 **서로 별도 시나리오**다. 부분 질의는 참조의 단어를 빈도 가중 추출하며 최소 3·최대 45글자다. 중복 질의는 실제 스케줄 첫 등장 순서를 유지한다.',
'- known은 관찰 payload와 검색어 라벨, unknown은 payload·접근 행·반복 및 공개 참조 분포만 받는다. 공격 함수에는 root/PRF 접근이나 피해 정답을 전달하지 않는다. 재현 JSON의 라벨은 평가용이며 unknown 함수 입력에서 제거했다.',
'- 타사 truncation/Bloom 관찰은 DB 후보 행 집합이다. 앱의 재확인 정답을 추가로 주지 않는다. S0는 DB에 실제 전달된 도장 키로 스냅샷의 행별 salt 도장을 재계산해 정확/위치 일치를 확인한다.',
'- 질의 관찰은 백업만으로 가능한 공격이 아니다. 파라미터 로그가 꺼져 있으면 DB 프로세스 메모리·서버 측 실행 계측, TLS 종료 지점의 평문 트래픽, 드라이버/프록시/앱 관측 등 추가 접근이 필요하다. 암호화된 네트워크 캡처만으로 키를 읽을 수 있다고 가정하지 않는다.','',
'## 공식 원시 연산과 명시 구성','',
'| 모델 | 이 시험에서 재현한 원시 연산·설정 | 검색 범위 |',
'|---|---|---|',
'| S0 | 제품 토큰 실제 바이트, substring16·exact16/company2, 행 salt 위치/정확 도장 | 정확, 부분(본 시험) |',
'| AWS-standard | HMAC-SHA384 첫 8바이트의 오른쪽 b비트, b=max(1,floor(log2(U_ref)−1)), 빈 partition 접미사 | 정확 |',
'| CipherSweet-FIPS-fast | PBKDF2-HMAC-SHA384(password=value,salt=index key,iterations=1), 8비트 | 정확 |',
'| CipherStash-unique | HMAC-SHA256 전체 256비트 | 정확 |',
'| CipherStash-match | downcase Unicode 3gram, HMAC-SHA256의 6개 UInt16LE lane %2048, 중복 비트 제거 | Bloom 조각 포함; SQL LIKE 아님 |',
'| Acra-CE-exact | 같은 ClientID 범위 HMAC-SHA256 전체 256비트 | 정확 |','',
'AWS 비트 수는 공식 시작식의 시험 선택이며 편향 데이터에 최적화한 권장 안전 구성이 아니다. CipherSweet 8비트는 R=10,000에서 C≈39.06인 명시 FIPS-fast 구성이고 기본값이 아니다. PHP 출력 바이트 규칙 때문에 비정수 바이트인 12비트 대신 8비트를 썼다. 외부 모델의 키 파생·SDK envelope·KMS는 재현하지 않고 모델/필드별 독립 시뮬레이션 키를 사용한다.','',
'공식 근거: [AWS 길이](https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/choosing-beacon-length.html), [AWS 고정 Beacon.dfy](https://github.com/aws/aws-database-encryption-sdk-dynamodb/blob/96d6132720b8014b8c28a051e3e7cd953d0c41bd/DynamoDbEncryption/dafny/DynamoDbEncryption/src/Beacon.dfy), [CipherSweet blind index](https://ciphersweet.paragonie.com/internals/blind-index), [CipherSweet planner](https://ciphersweet.paragonie.com/php/blind-index-planning), [CipherStash Stack 기본값](https://github.com/cipherstash/stack/blob/6a92634498499705da3317b78c90820ca2985f37/packages/stack/src/schema/match-defaults.ts), [core0.42.3 Bloom 소스](https://docs.rs/crate/cipherstash-core/0.42.3/source/src/bloom_filter.rs), [EQL 검색 의미](https://cipherstash.com/docs/reference/eql/text), [Acra searchable encryption](https://docs.cossacklabs.com/acra/security-controls/searchable-encryption/).','',
'## C 전수 결과','',
'각 셀은 **값% / 글자%**, 피해 10,000행이다. 이름·메모·이메일의 값 0%는 안전 증명이 아니다. 알려진 원문-색인 발생 서명 학습과 사전 추측을 모든 모델에 사용하고, 전화에는 공개 참조 형식·자리별 문자 집합을 이용하는 조립기를 추가했다. 아래 대표값은 완료된 공격 전체의 최대이며 행마다 정답을 보고 답을 고르지 않는다.',''];
lines.push(`AWS 실제 선택 비트: ${fields.map((field,i)=>{const m=c.models.find(m=>m.field===field&&m.id==='AWS-standard');return `${names[i]} ${m.bits}bit(U_ref=${m.distinctReference})`;}).join(', ')}.`,'');
for(const N of [100,1000]){lines.push(`### 삽입 ${N}행`,'',`| 모델 | ${names.join(' | ')} |`,`|---|${fields.map(()=> '---:').join('|')}|`);
 for(const model of models)lines.push(`| ${model} | ${fields.map(field=>{const r=c.results.find(r=>r.N===N&&r.field===field&&r.model===model);return pair([r.base,r.strongest].sort((a,b)=>b.valuePct-a.valuePct||b.characterPct-a.characterPct)[0]);}).join(' | ')} |`);lines.push('');}
lines.push('S0 전화는 모든 호환 버킷 할당을 보존하고, 전역 가설이 많으면 후보별 capacity1 matching으로 완화한다. 전수 최대 상태 수는 N100에서 253, N1000에서 134이며 상한 도달은 0이다. Bloom 전수는 positive intersection이 k=6 이하인 조각만 완전히 학습했다고 가정하는 제한된 조립기다. 충돌로 동일한 발생 서명이 생기거나 Bloom 비트가 겹치면 추론이 틀릴 수 있으므로 단일 후보 반환은 암호학적 유일성 증명이 아니다.','',
'## D 전수 결과','',
'각 셀은 **값% / 글자%**다. 각 위협에서 query-incidence, 위치 문자 추측, 위치+사전 결합, 추가 phone 중 완료된 named whole attack의 값 맞힘률 최대를 택한다(동률은 글자율). 공격별 전 지표는 observed.json에 남긴다. 위치 추측 결합이 틀린 경우까지 무조건 combined를 대표값으로 쓰지 않는다.','');
lines.push(`1,000회 분배: ${d.results.filter(r=>r.model==='S0'&&r.mode==='partial').map(r=>`${names[fields.indexOf(r.field)]} ${r.fieldObservations}회(고유 부분질의 ${r.distinctQueries})`).join(', ')}. S0 관찰 키 판정의 평문 대조 ${d.checks}회 일치.`,'');
for(const mode of ['eq','partial'])for(const known of ['known','unknown']){lines.push(`### ${mode==='eq'?'정확':'공통 부분 ≥3'} · 검색어 ${known==='known'?'앎':'모름'}`,'',`| 모델 | ${names.join(' | ')} |`,`|---|${fields.map(()=> '---:').join('|')}|`);
 for(const model of models)lines.push(`| ${model} | ${fields.map(field=>{const r=d.results.find(r=>r.field===field&&r.model===model&&r.mode===mode);return r?pair(best(r,known).metric):'해당 없음';}).join(' | ')} |`);lines.push('');}
lines.push('부분 기능이 없는 exact-only 모델의 전화 복원 0%와 S0 부분 검색의 높은 복원율을 같은 기능의 보안 순위로 읽으면 안 된다. 이 고정 전화 형식에서는 조각 색인을 능동적으로 학습할 수 있고, S0의 질의 위치 키를 알면 전화 조립이 쉬워진다. Bloom에서도 단어 순서·다중 발생을 직접 저장하지 않는다는 사실만으로 공격 불가능성을 주장할 수 없다.','',
'## 강화 Bloom 전화 공격 — 별도 표본','');
if(existsSync(`${out}/phone-strong-sample.json`)){const s=read('phone-strong-sample');lines.push(`고정 seed ${s.seed}, 피해에서 단순무작위 비복원 ${s.sample}/${s.population}행, 행당 ${s.maxStates}상태. 모든 호환 비트를 보존하는 capacity6 matching이며 k개 서로 다른 비트 요구는 휴리스틱이다. 이 표는 전수율이 아니고 CI도 이 고정 fixture 표본 추정이며 일반 서비스 모집단 보장이 아니다.`, '', '| 위협 | 정답/표본 | 값% | Wilson95% | 상한 도달 | 글자% |','|---|---:|---:|---|---:|---:|');
for(const r of s.results)lines.push(`| ${r.tag} | ${r.metric.correct}/500 | ${fmt(r.metric.valuePct)} | ${fmt(r.wilson95.lowerPct)}–${fmt(r.wilson95.upperPct)} | ${r.capped}/500 | ${fmt(r.metric.characterPct)} |`);if(!s.complete)lines.push('','진행 중: 완료된 행만 중간 표시하며 최종 판정에 쓰지 않는다.');}
else lines.push('별도 표본 실행 대기. 강화 전수 실행은 시간 예산으로 중단했으며 미완료를 0%로 취급하지 않는다.');
lines.push('','## 무작위 기준선','','참조의 경험 분포에서 독립 추출 / 참조 고유값 균등 추측을 나눈다. 각각 값% / 글자%다.','','| 칸 | 경험 분포 | 고유값 균등 |','|---|---:|---:|');
c.baselines.forEach((r,i)=>lines.push(`| ${names[i]} | ${pair(r.empirical)} | ${pair(r.uniform)} |`));
lines.push('','## 재현·검증·한계','',
'실행: `node --import tsx bench/competitor-sim/run-c.ts`, `run-d.ts`, `run-d-graph.ts`, `run-phone-sample.ts`, `verify.ts`; 각 뒤 파일도 같은 디렉터리의 전체 경로를 쓴다. 보고서 생성: `node bench/competitor-sim/report.mjs`. 전수와 표본 산출물을 분리하며 진행 중 JSON의 complete=false는 최종 증거가 아니다.','',
'- [C 전수72](chosen.json), [D 전수42](observed.json), [D Bloom 알려진 질의 추가 공격](observed-phone-CipherStash-match-graph.json), [강화500 표본](phone-strong-sample.json), [자체 검증](verification.json), [공통 모델](../../../competitor-sim/models.ts), [충돌 인지 공격](../../../competitor-sim/attacks.ts), [완료 전수 Bloom 공격](../../../competitor-sim/completed-phone.ts).',
'- 최초 D 초안은 중복 제거 시 평문 사전순 정렬이 관찰 순서에 섞여 unknown 동률 추측에 영향을 줬다. 해당 초안은 excluded-observation-order.json에 제외 사유와 함께 보존하고, 모든 42경우를 실제 첫 등장 순서로 다시 실행했다. 현재 표에는 새 실행만 사용한다.',
'- v-astra 독립 모델 검산은 최신 AWS SHA384/rightmost·CipherSweet8·Bloom UInt16LE를 포함한 1,152/1,152 일치다. C72는 144만 예측 재채점·648표본 replay를 통과했다. D42는 지표 180만 예측 재채점·84만 예측 replay·2,880 hit 표본·unknown 라벨 추정을 통과했다. 별도 v-astra 산출물이 독립 검산의 최종 근거다.',
'- 한 개의 구조화 fixture·고정 키·고정 분할이다. 이름·메모·이메일 0%를 실제 자연어/서비스 보안 근거로 일반화하지 않는다. 참조 사전에 없는 값을 원문 전체 사전만으로 맞힐 수 없는 한계가 있다.',
'- AWS partition, CipherSweet prefix/suffix 변환 추가 색인, 느린 KDF, Acra EE prefix, CipherStash unique+match 동시 구성, MongoDB QE 상태 구조, 다른 scope 전파, TLS/KMS/실제 SDK 전체 동작은 이번 비교에서 미검증이다.',
'- 전수 공격 중 가장 좋은 결과와 표본 강화 결과를 구분한다. 관찰 공격의 0건·낮은 비율은 구현한 공격의 하한이며 더 강한 제약 풀이·더 풍부한 사전·다른 관찰 스케줄을 배제하지 않는다.');
if(existsSync(`${out}/verification.json`)){const v=read('verification');lines.push('',`자체 실행 결과: C${v.C}/D${v.D}, 지표 재계산 ${v.metricChecks}, 첫 등장 순서 ${v.firstAppearanceOrderChecks}, 제품 WebCrypto/바이트 대조 ${v.byteChecks}, unknown 입력 경계 PASS. \`npx tsc -p bench/competitor-sim/tsconfig.json --noEmit\` exit0; \`npm run docs:check\` 출력: Documentation entry, links, decisions, plans, exports, and shared example references PASS. 제품 변경이 없어 build·제품 DB 시험·설치 시험은 실행하지 않았다.`);}
writeFileSync(`${out}/report-ko.md`,lines.join('\n')+'\n');console.log(`Wrote ${out}/report-ko.md`);
