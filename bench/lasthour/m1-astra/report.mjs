import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const out='bench/results/2026-09-29-lasthour/m1-astra',load=n=>JSON.parse(readFileSync(`${out}/${n}.json`,'utf8'));
const o=load('observation'),b=load('bits'),c=load('collision'),p=load('phone-queries');for(const d of [o,b,c,p])assert(d.complete);
assert.equal(o.queries.length,1000);assert.equal(o.validation.p2SameTokenUnions,1000);assert.equal(o.validation.unchangedProofPayloads,2000);assert.equal(b.attack.length,30);assert.equal(c.results.length,6);assert.equal(p.results.length,18);
for(const r of c.results){assert.equal(r.unique,r.uniqueCorrect);assert.equal(r.unique+r.ambiguous+r.none+r.capped,1000);assert.equal(r.samples.filter(s=>s.uniqueCorrect).length,r.uniqueCorrect);assert.equal(r.capped,0);assert.equal(r.none,0);assert.equal(r.hypotheses,1);}
for(const path of ['P0','P1','P2'])for(const field of ['name','phone','address','memo','email','company'])assert.equal(o.results.filter(r=>r.path===path&&r.field===field).length,3);
for(const r of o.results.filter(r=>r.path==='P0')){const other=o.results.find(s=>s.path==='P2'&&s.field===r.field&&s.observations===r.observations);assert.deepEqual({...r,path:'P2'},other);}
const n=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:2}),f=v=>Number(v).toFixed(2),table=(head,rows)=>`| ${head.join(' | ')} |\n| ${head.map(()=> '---').join(' | ')} |\n${rows.map(r=>'| '+r.join(' | ')+' |').join('\n')}\n`;
const obs=path=>o.results.filter(r=>r.path===path&&r.observations===1000),sum=(rs,k)=>rs.reduce((a,r)=>a+r[k],0),base=obs('P0'),cap=obs('P1');
const bitsRows=b.summary.map(r=>[r.field,r.bits,r.width,r.group==='rare-1-10'?'드묾':'빈도 하위 대조',r.n,`${f(r.candidates.mean)} / ${n(r.candidates.max)}`,f(r.ratioOfMeans),f(r.relative16.max)]);
let md=`# 마지막 보안 검증: cap3·P2와 칸별 비트

**정정:** 전화 10비트의 약한 공격 복원율 3.1%를 보안 개선 근거로 쓸 수 없다. 충돌 사전을 함께 푸는 공격에서는 16·12·10비트 모두 **996/1,000행(99.6%)을 유일하게 복원**했다. **미측정:** SQL 왕복·전체 지연·목록300·운영 데이터·다중 키 분포. 메모리 전용이며 DB 접속·측정 락·제품 수정은 없었다.

## 선택지 판정

${table(['후보','확인한 보안 효과','대가 / 한계','판정'],[
['P1: 후보 토큰 최대3개만 전송',`토큰 전송 ${n(sum(base,'transmittedTokens'))}→${n(sum(cap,'transmittedTokens'))}, ${f((1-sum(cap,'transmittedTokens')/sum(base,'transmittedTokens'))*100)}% 감소; 이번 전체 값 복원율 감소 없음`,'도장 조각 키 2,059회 전송은 동일; SQL 성능은 별도 담당 측정','보안 개선안으로 확정하지 않음'],
['P2: cap3 + rest 별도 함수','관찰 가능한 토큰 합집합이 P0와 1,000/1,000질의 동일','도장 키·offset·길이도 동일; 비인라인은 최적화 경계일 뿐 비밀 경계 아님','질의 계획 후보이며 토큰 은닉 효과 없음'],
['전화 10·12비트','강한 공격의 유일 복원율 99.6%로 16비트와 동일','2글자 개별 후보 최대 4.07배 / 3.54배; 재토큰화 필요','보안 이득을 이유로 채택할 근거 없음'],
['주소 12비트','정상 주소값 삽입 공격 81.9%로 16비트와 동일','2글자 개별 후보 최대 19.54배; 드문 4글자는 1개뿐','보안 이득·미세 손해를 함께 입증하지 못함']
])}

## 데이터와 공격자 입력

기존 fixture의 고정 시드·100,000행을 [원래 재현기](../../../fixture/generator.ts)로 메모리에 재현했다. 새 데이터나 DB 적재는 없다. ID 순서의 두 SHA-256은 기존 attack-extra·전화 비트 결과와 같고, 기존 16/12비트 공격 24건과 전화 검색 후보 882건도 정확히 재현했다. 이번에는 DB 원문 전수 대조를 다시 하지 않았다.

관찰 실험은 기존 [attack-extra](../../../attack-extra/memory.ts)의 seed 714029, 전역 1,000질의, 칸 균등 배정·분리 참조의 단어 빈도 표집을 그대로 썼다. 피해 첫 10,000행·참조 다음 10,000행이다. 선택 삽입은 앞선 비트 실험과 같이 참조 첫 10,000행·피해 다음 1,000행이다. 두 실험의 표본 역할이 다르며 각 실험 안에서 ID는 겹치지 않는다; 값 중복은 허용한다.

관찰 공격자는 후보 토큰 저장물·암호문에서 유도한 UTF-8 바이트 길이·독립 참조 사전·관찰한 검색어의 알려진 평문 라벨을 가진다. **검색어 평문도 모르는 무조건 토큰 전용 공격이 아니다.** 도장 키·salt·위치 배열·정규화 길이는 이 예측기에 주지 않는다. 선택 삽입 공격은 질의 관찰 키가 전혀 없고, 알려진 삽입값과 그 저장 후보 토큰 및 피해 후보 토큰만 사용한다. 키와 피해 평문은 토큰 생성·사후 점수 검증에만 쓴다.

## (a) 같은 1,000질의의 전송물과 복원

P1은 실제 [SQL 변형 코드](../../../lasthour/r9-impl/variants.ts)처럼 정렬 토큰의 처음·중간·끝을 보낸다. P2는 나머지를 별도 인자로 보내므로 DB 관찰자는 합칠 수 있다. 실제 변형 함수에 토큰·도장 payload를 넣어 1,000건을 단언했다. 전송 횟수는 중복 포함, 고유 수는 칸별 도메인 합계다. 원시 증거: [observation.json](observation.json).

${table(['경로','후보 토큰 전송 / 고유','도장 키 전송 / 고유','전체 payload 비교'],['P0','P1','P2'].map(path=>{const rs=obs(path);return [path,`${n(sum(rs,'transmittedTokens'))} / ${n(sum(rs,'distinctTokens'))}`,`${n(sum(rs,'proofKeyTransmissions'))} / ${n(sum(rs,'distinctProofKeys'))}`,path==='P0'?'기준':path==='P1'?'후보 토큰만 감소':'head+rest=P0'];}))}

토큰 묶음 공격은 기존 사전 서명 방식을 사용한다. P1에서는 일부 토큰이 빠져도 **피해 행에 보낸 토큰 하나가 없으면, 그 검색어를 포함하는 사전 값은 배제**할 수 있다. 이 음성 증거를 버리지 않았다. 완전히 전송된 짧은 묶음은 기존 양방향 서명을 사용한다. 별도로 고유 토큰 대응 학습+사전/전화 그래프 공격도 실행했다; P1의 선택된 조각 라벨을 비밀 키로 미리 알려 주지 않는다.

${table(['칸','질의 수','후보 토큰 P0→P1','묶음·배제 전체 복원 % P0/P1/P2','토큰 대응 공격 % P0/P1/P2'],base.map(r=>{const q=cap.find(x=>x.field===r.field);return [r.field,r.fieldObservations,`${r.transmittedTokens}→${q.transmittedTokens}`,`${f(r.partialConstraintPct)} / ${f(q.partialConstraintPct)} / ${f(r.partialConstraintPct)}`,`${f(r.mappedPct)} / ${f(q.mappedPct)} / ${f(r.mappedPct)}`];}))}

전체 값이 0%인 칸도 일부 문자·행을 맞힌다; 0건을 안전 근거로 쓰지 않는다. 모든 단계(10/100/1,000회)의 문자 정답 수·80% 이상 행 수·고유 대응 수는 JSON에 있다. 특히 회사는 짧은 완전 묶음만 보게 만든 약한 분석에서 100→70.17%로 보이지만, **부분 묶음의 배제 정보까지 쓰면 P1도 100%**다. 주소의 더 강한 토큰 대응 공격도 10.50→10.50%로 같다. 이 결과는 모든 T4 공격의 동일성 증명이 아니라, 전송량 감소를 복원 감소로 곧바로 환산할 수 없다는 반례다.

**확실:** 판정용 조각 키·offset·길이는 P0/P1/P2에서 그대로이며, 기존 도장 키 관찰에 따른 위치 채널은 이 변경으로 제거되지 않는다. P2의 전체 토큰 관찰 정보는 아예 동일하다. **모름:** 알려진 검색어 라벨이 없는 공격·다른 질의 분포·참조 사전에서 P1이 얼마나 이득인지.

## (b) 선택 삽입: 약한 공격과 충돌 대응 공격

폭은 substring에만 적용한다. exact16(회사 exact2), 도장, 암호문은 그대로다. descriptor에 비트 수가 들어가므로 폭마다 파생 키도 달라진다; 같은16비트 출력의 단순 하위 비트 제거가 아니다. 현재 제품 API는 substring10/12를 지원하지 않으며 채택하면 저장 후보·질의 토큰을 함께 다시 만들어야 한다.

기존 공격 재실행, 피해 1,000행의 정규화 전체 값 복원율(%). 원시 증거: [bits.json](bits.json).

${table(['칸','삽입 방식','N','16비트','12비트','10비트'],['phone','address'].flatMap(field=>['whole-values','packed-pieces'].flatMap(strategy=>[10,100,1000].map(count=>[field,strategy,count,...[16,12,10].map(bits=>{const r=b.attack.find(r=>r.field===field&&r.strategy===strategy&&r.n===count&&r.bits===bits);return r?f(r.pct):'측정 안 함';})]))))}

삽입 수가 늘어도 약한 공격의 점수가 비단조인 것은 고유 서명 학습·엄격한 사전 대응이 충돌에 민감하기 때문이다. 공격자는 이전에 얻은 결과를 버릴 필요가 없으며, 이 표를 최강 공격의 상한으로 읽지 않는다.

### 추가 지시: 충돌을 아는 공격으로 반증

1. 알려진 삽입에서 조각 p가 나온 행의 비트 서명 S(p), 버킷 t가 나온 서명 S(t)를 만든다. 실제 대응이면 S(p) ⊆ S(t)이므로 같은 버킷의 여러 조각을 버리지 않고 후보 집합으로 유지한다.
2. p→t가 여럿인 경우도 모두 가설로 남기고, 각 가설이 **알려진 삽입의 전체 토큰 집합**을 재현하는지 검사한다. packed10비트는 4→1가설, 정상 전화값 삽입은 각 폭256→1가설이 됐다. 비밀 키로 정답 가설을 고르지 않았다.
3. 분리 참조에서 배운 12자 전화의 자리별 숫자·하이픈 제약 안에서 조립한다. 인접 조각·skip 조각·시작·끝 토큰이 모두 피해 버킷에 있어야 하고, 마지막에는 **전체 토큰 집합이 정확히 같아야** 한다. 두 해가 나오면 모호로, 끝까지 하나만 나오면 유일 복원으로 센다.

원시 증거와 구현: [collision.json](collision.json), [collision.ts](../../../lasthour/m1-astra/collision.ts). 같은 피해·참조·삽입1,000건이며, packed뿐 아니라 실제 fixture의 정상 전화값을 그대로 입력한 whole-values도 확인했다.

${table(['삽입 방식','비트','학습 조각 / 버킷','유일 정확 복원','모호 / 실패 / 상한','DFS 평균 / 최대 상태'],c.results.map(r=>[r.strategy,r.bits,`${r.pieces} / ${r.buckets}`,`${r.uniqueCorrect}/1000 (${f(r.uniquePct)}%)`,`${r.ambiguous} / ${r.none} / ${r.capped}`,`${f(r.states.mean)} / ${r.states.max}`]))}

유일 복원 오답은 0건, 6경로 모두 탐색 상한 도달은 0건이다. 피해 전화값과 참조 전화값의 교집합은 0건이므로 외운 입력을 그대로 돌려준 결과가 아니다. packed10비트의 264조각은230버킷에 들어가고 충돌 버킷32개·최대3조각이다. 충돌은 후보를 약간 늘렸지만 전화 형식·다른 조각과의 일관성으로 해소됐다. 남은4행은 두 해가 가능했으며, 첫 해를 임의 선택하면998행이 맞지만 이를 유일 복원으로 세지 않았다.

**확실:** 이 데이터·공격자에서 95.9→51.5→3.1% 감소는 약한 공격이 충돌 조각을 버린 결과이며, 실제 복원 저항 향상의 근거가 아니다. 전화값만 삽입하는 경로도 같으므로 긴 조각 묶음 입력 허용 여부가 이 결론을 좌우하지 않는다. **모름:** 다른 키·전화 형식·더 적은 삽입 예산의 분포; 이번 실험은 비트 축소가 모든 상황에서 수학적으로 무효라는 증명은 아니다.

## 후보 행 증가: 100,000행, SQL 시간 아님

DF1~10을 드문 검색으로 정하고 길이별 최대200개를 고정 시드로 표집했다. 없으면 빈도 하위 검색어를 **별도 대조군**으로 쓴다. 전화2/3글자와 주소2/3글자에는 드문 검색어가 없다. 주소4글자는 드문 검색어가1개뿐이므로 그 한 건의 동일 후보 수로 일반화하지 않는다. 각 일치 행이 후보에 포함됨을 평문 전수 대조했다.

${table(['칸','비트','길이','표본 종류','검색어 수','후보 평균 / 최대','평균 후보/16','개별 최대/16'],bitsRows)}

평균 배수는 후보 합의 비율이다; 개별 최대 배수와 최대 후보 행 수는 다른 지표다. 전화12비트의 2글자 '47'은7,020→24,875행, 10비트의 '98'은5,879→23,906행이다. 주소12비트의 '04'는900→17,585행이다. 서로 다른 파생 키 때문에 10비트의 특정 표본 최대가12비트보다 작을 수 있다.

### 추가 지시: 기존55조건의 전화 경로

55조건에서 전화 leaf6개를 추출했다. AND/OR 전체의 비용으로 부풀리지 않고 해당 전화 조건을 단독으로 평가했다. 원시 증거: [phone-queries.json](phone-queries.json).

${table(['전화 조건','평문 일치','16비트 후보','12비트 후보','10비트 후보','10비트 추가 / 배수'],p.results.filter(r=>r.bits===16).map(r=>{const q=p.results.find(x=>x.bits===12&&x.op===r.op&&x.value===r.value),s=p.results.find(x=>x.bits===10&&x.op===r.op&&x.value===r.value);return [r.op+' '+r.value,n(r.matches),n(r.candidates),n(q.candidates),n(s.candidates),`${s.extra>=0?'+':''}${s.extra} / ${f(s.ratio)}`];}))}

'41-' 시작 검색의 후보 판정 작업량은 10비트에서 **+147행, +10.43%로 추정**된다(행당 비용 동일 가정). 다른 다섯 조건의 후보 수는 같다. exact는 변형 대상이 아니며 1행 정답에2후보가 나오는 것은 기존16비트 exact 충돌이다. 이 작업량 비율을 SQL 지연 배수로 읽지 않는다: 새 오탐의 빠른 탈락, 배열 크기, GIN/heap 접근, AND/OR·목록 중단이 영향을 준다. 실제 SQL ms는 측정 안 함이며 1초 기준 충족도 이 보고서로 판정하지 않는다.

## 검증과 재실행

독립 WebCrypto 토큰 ${b.validation.cryptoChecks+o.validation.productCryptoChecks}건, 기존 공격24건·전화 후보882건 재현, 비트 후보에서 평문 일치 ${n(b.validation.noFalseNegatives)}건의 누락0을 확인했다. P2 토큰 합집합1,000건·도장 payload불변2,000건, 충돌 공격의 모든 삽입 ${n(c.validation.probeTokenSets)}건 재현·피해 정답 허용성 ${n(c.validation.groundTruthAdmissible)}건·유일 해 평문 일치를 단언했다. 추가로 비트 폭만 바꿔 도장 질의를 컴파일한20건도 동일했다. [최종 검증·출처 해시](verification.json)에 타입 검사·산술·링크·로컬 경로/사용자명 제외 검사를 기록했다. 전체 docs:check는 다른 담당자의 아직 생성되지 않은 보고서로 향하는 공유 bench/README.md 링크 때문에 일시 실패했고, 이 보고서의 상대 링크는 모두 통과했다.

실행(메모리만):

\`\`\`powershell
rtk proxy node --import tsx bench/lasthour/m1-astra/bits.ts
rtk proxy node --import tsx bench/lasthour/m1-astra/observation.ts
rtk proxy node --import tsx bench/lasthour/m1-astra/collision.ts
rtk proxy node --import tsx bench/lasthour/m1-astra/phone-queries.ts
rtk proxy node bench/lasthour/m1-astra/report.mjs
rtk proxy node --import tsx bench/lasthour/m1-astra/verify.ts
\`\`\`

사용한 공격은 복원 가능한 양의 하한이다. 미사용 공격: 대규모 다중 키 분포, 충돌+통계 공동 최적화, 질의 평문 라벨 없는 최적 공격, 실제 전화 입력 정책을 포함한 운영 공격. 이번 자연어 공개 말뭉치 추가 실험은 하지 않았으며 고정 형식 전화·주소의 합성 fixture에 한정한다. **로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.**
`;
writeFileSync(`${out}/report-ko.md`,md);console.log('PASS report arithmetic; wrote report-ko.md');
