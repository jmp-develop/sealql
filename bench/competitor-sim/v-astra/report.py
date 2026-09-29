"""Build comparison tables from independently reviewed memory evidence; no DB."""
from pathlib import Path
import json, hashlib
ROOT=Path('bench/results/2026-09-30-competitor-sim')
OUT=ROOT/'v-astra'
def read(p):return json.loads((ROOT/p).read_text(encoding='utf-8'))
ab=read('m1-astra/results.json'); c=read('r9-impl/chosen.json'); d=read('r9-impl/observed.json')
assert ab['complete'] and c['complete'] and d['complete']
samples=read('v-astra/verify-samples.json')
for p in ['verify-models.json','verify-attacks-ab.json','verify-attacks-c.json','verify-observed.json','verify-samples.json']:
 assert read('v-astra/'+p)['complete'],p
graph_path=ROOT/'r9-impl/observed-phone-CipherStash-match-graph.json'
if graph_path.exists():
 assert read('v-astra/verify-observed-graph.json')['complete']
 graph=json.loads(graph_path.read_text(encoding='utf-8'))
 for row in d['results']:
  if (row['field'],row['model'],row['mode'])==('phone','CipherStash-match','partial'):row['knownGraph']=graph['metric']
fields=['name','phone','address','memo','email','company']
names={'name':'이름','phone':'전화','address':'주소','memo':'메모','email':'이메일','company':'회사'}
models=['S0','AWS-standard','CipherSweet-FIPS-fast','CipherStash-unique','CipherStash-match','Acra-CE-exact']
labels={'S0':'SealQL','AWS-standard':'AWS beacon','CipherSweet-FIPS-fast':'CipherSweet 8b','CipherStash-unique':'EQL unique','CipherStash-match':'EQL match','Acra-CE-exact':'Acra CE'}
def pct(n):return f'{n:.2f}'
def best(field,model,known,channel='index'):
 return max((r for r in ab['results'] if (r['field'],r['model'],r['known'],r['channel'])==(field,model,known,channel)),key=lambda r:r['pct'])
def bestd(row,prefix):
 return max((row[k] for k in [prefix,prefix+'Combined',prefix+'Positions',prefix+'Graph'] if row.get(k)),key=lambda r:(r['valuePct'],r['characterPct']))
lines=['# 검색 색인 누출 재현: 같은 데이터·같은 공격 비교','',
'**이 보고서는 제품 전체의 침해 성공률이 아니라 공개 색인 구조의 메모리 공격 실험이다.** 현재 SealQL이 타 제품보다 전반적으로 안전하다는 결론을 뒷받침하지 않는다. 결정적 조각을 저장하는 부분검색 모델과 값 전체만 저장하는 정확검색 모델의 기능·관찰 정보 차이를 구분해야 한다.','',
'## 조건과 재현 범위','',
'기존 10만 행 fixture를 고정 seed로 메모리에 재생했다. 모든 원문 값의 SHA-256은 앞선 공개 API 적재 시 실제 DB에서 읽어 저장한 원문 해시와 일치한다. 이번 실행에는 DB 접속·제품 변경이 없다. 같은 피해 10,000행·참조 10,000행의 ID는 겹치지 않는다. 모든 모델 입력에 앱 수준의 SealQL compact 정규화를 먼저 적용하고, 표의 복원은 이 정규화 값 전체가 일치한 비율(%)이다. 외부 제품 자체 정규화라고 주장하지 않는다.','',
'참조 사전에 피해 정규화 값이 포함된 비율은 이름0%·전화0%·주소82.17%·메모0%·이메일0%·회사100%다. 따라서 이름·전화·메모·이메일의 정확검색 사전 공격0%는 특히 사전 불포함의 영향이 크다. 조각 조립은 사전에 없는 전화 값도 생성할 수 있어 전체값 사전 공격과 결과가 달라진다.','',
'A는 참조 분포만 아는 백업 공격, B는 피해 원문 100/500개를 알고 나머지 9,900/9,500개만 채점한 공격, C는 참조에서 고른 정상 값 100/1,000개를 같은 키 범위에 삽입하고 색인을 관찰한 공격이다. 삽입 예산은 횟수이며 중복 값도 포함한다. D는 질의 총 1,000회를 6개 필드에 같은 스케줄로 나눈 관찰 공격이며 검색어를 아는 경우/모르는 경우를 분리했다. 반복 질의는 동일 관찰로 합치고 최초 도착 순서를 유지했다. 정확검색과 부분검색은 별도 실험이다.','',
'백업 표의 기본 관찰은 결정적 색인뿐이다. 원문 바이트 길이를 모든 모델에 똑같이 추가한 민감도 실험은 별도이며, 실제 외부 SDK 암호문 봉투를 재현한 것이 아니다. SealQL 고유 길이·위치 메타데이터 전체를 모든 T1 공격이 활용한 것도 아니다. 비밀 키와 피해 정답은 인코더·채점기에만 있으며 공격 함수에는 주어지지 않는다.','',
'대표값은 이름을 기록한 공격 가족 중 **전체 실행 복원율이 가장 높은 한 공격**이다. 피해 행마다 정답을 보고 공격을 고르는 방식이 아니다. 아래 0%는 이 사전·공격으로 복원하지 못했다는 뜻이며 안전성 증명이 아니다.','',
'| 모델 | 실제 재현한 색인 | 검색 전제·중요 한계 |','|---|---|---|',
'| SealQL | 실제 제품 조각 16bit, exact 기본16/company2, 행별 위치·정확 도장 | P1은 질의 후보만 최대3개, 저장 조각·판정 키는 유지 |',
'| AWS beacon | HMAC-SHA384 첫8B의 오른쪽 b비트 | 단일 partition; b=max(1,floor(log2(참조 고유값)-1)); 편향 데이터에 맞춘 안전 설정 아님 |',
'| CipherSweet | FIPS-fast PBKDF2-HMAC-SHA384 1회,8bit | 명시적 실험 설정이며 제품 기본값 아님; 값 전체 정확검색 |',
'| EQL unique | HMAC-SHA256 256bit | 정확검색; ordering 색인 제외 |',
'| EQL match | Unicode 3gram/downcase; HMAC-SHA256의 UInt16LE 6개; Bloom2048bit | Stack/EQL3 기본 m2048/k6; LIKE가 아닌 확률적 조각 포함 |',
'| Acra CE | HMAC-SHA256 256bit | 정확검색; EE prefix 제외; 같은 ClientID 범위 |','',
'AWS 비트는 이름12/전화12/주소11/메모12/이메일12/회사3이다. 참조 고유값은 각각10,000/10,000/4,890/10,000/10,000/16개다. CipherSweet8bit는 이 실험의 동일 설정이며 저어휘 회사 필드에 대한 권장 안전 설정이라고 주장하지 않는다.','',
'외부 모델은 독립 시뮬레이션 필드 키를 사용한다. 실제 SDK 키 파생·암호문 봉투·네트워크·접근제어·enclave·로그를 구현하지 않았으므로 SDK 상호운용성이나 배포 제품 공격으로 표현하지 않는다. Acra의 실제 동일 ClientID 키 재사용에 따른 필드 간 상관 공격도 범위 밖이다. 모델 규칙과 고정 소스는 [model-rules-ko.md](model-rules-ko.md)를 따른다.','',
'## A/B: 백업·알려진 원문','',
'| 필드 | 색인 모델 | A 백업만 | B 원문1% | B 원문5% | B5 대표 공격 |','|---|---|---:|---:|---:|---|']
for f in fields:
 for m in models:
  b=best(f,m,500);lines.append(f'| {names[f]} | {labels[m]} | {pct(best(f,m,0)["pct"])} | {pct(best(f,m,100)["pct"])} | {pct(b["pct"])} | {b["method"]} |')
lines+=['','대표 공격 이름은 재현용 식별자다. group_frequency는 색인 등가그룹 빈도, known_projection/shared_known_dictionary는 알려진 조각과 사전의 대응, known_fingerprint는 알려진 전체 색인 재사용, shared_collision_phone은 충돌을 고려한 전화 조각 조립이다.','',
'Bloom 전화의 강화 조립 공격은 시간 예산에 따라 아래 별도 500행 표본 표에서 보고한다. A/B 표의 Bloom 전화 전수값만으로 강화 공격 복원율을 판단하면 안 된다.','', '## C: 선택 삽입','',
'값 복원과 위치별 글자 일치는 서로 다르다. 글자 비율에는 전화 접두부·공통 서식처럼 원래 예측 쉬운 글자도 포함되므로 무작위 기준선과 함께 읽는다.','',
'| 필드 | 색인 모델 | N100 값% | N1000 값% | N1000 글자% |','|---|---|---:|---:|---:|']
for f in fields:
 for m in models:
  a=next(r for r in c['results'] if (r['field'],r['model'],r['N'])==(f,m,100))
  b=next(r for r in c['results'] if (r['field'],r['model'],r['N'])==(f,m,1000))
  lines.append(f'| {names[f]} | {labels[m]} | {pct(a["strongest"]["valuePct"])} | {pct(b["strongest"]["valuePct"])} | {pct(b["strongest"]["characterPct"])} |')
lines+=['','## D: 질의 관찰','',
'외부 절단/Bloom 모델은 DB가 보는 후보 행 집합을 사용한다. 앱이 재확인한 최종 정답 집합까지 자동으로 알려주지 않는다. SealQL은 DB에 전달된 판정 키로 행별 도장을 시험할 수 있어 정확한 위치·일치가 드러나는 경우를 포함한다. 원문 미상 공격은 정답 라벨과 정답 사전순 관찰 순서를 받지 않는다.','',
'D는 백업만으로 가능한 공격이 아니다. 실제 쿼리 파라미터를 보는 DB 메모리·실행 계측, 평문 파라미터 로그, TLS 종료 지점 또는 앱·드라이버 관찰 같은 추가 권한을 전제한다. TLS로 암호화된 네트워크 패킷만 수집해 판정 키를 읽을 수 있다고 가정하지 않는다.','',
'| 필드 | 모델·검색 | 해당 필드 질의 수 | 원문 앎 값% | 원문 모름 값% | 앎 글자% | 모름 글자% |','|---|---|---:|---:|---:|---:|---:|']
for r in d['results']:
 k=bestd(r,'known');u=bestd(r,'unknown');mode={'eq':'정확','partial':'부분'}[r['mode']];lines.append(f'| {names[r["field"]]} | {labels[r["model"]]} / {mode} | {r["fieldObservations"]} | {pct(k["valuePct"])} | {pct(u["valuePct"])} | {pct(k["characterPct"])} | {pct(u["characterPct"])} |')
lines+=['','EQL match의 정확검색, exact-only 모델의 부분검색은 해당 없음이며 0%로 채우지 않았다. SealQL eq/partial도 서로 별도 관찰 예산이므로 두 실행 정보를 합친 공격 결과가 아니다.','',
'## Bloom 전화 강화 공격: 별도 500행 표본','',
'전수 결과를 표본 결과로 덮어쓰지 않는다. 고정 seed의 단순무작위 500행에서만 더 넓은 비트 대응 가설을 탐색했다. 모든 강화 표본은 행당20,000상태를 쓰고, 상한에 이르면 기본 사전 예측으로 돌아간다. 완료된 SealQL 전수 조립은 기존2,000,000상태 상한을 유지했으므로 계산 예산까지 같은 실험은 아니다. B는 알려진 원문을 제외한 모집단에서 뽑는다. 95% 구간은 Wilson 이항 근사(유한 모집단 보정 없음)이며 이 고정 fixture에 대한 표본 불확실성만 나타낸다. 다른 데이터·키·서비스에 대한 보장 구간이 아니다.','',
'| 조건 | 모집단 | 표본 | 정답 | 값 복원% | Wilson95% | 상한 도달 | seed |','|---|---:|---:|---:|---:|---|---:|---:|']
for s in samples['rows']:
 lo,hi=s['wilson95'];lines.append(f'| {s["tag"]} | {s["population"]} | {s["sampleRows"]} | {s["correct"]} | {pct(s["valuePct"])} | {pct(lo)}–{pct(hi)} | {s["capped"]} | {s["seed"]} |')
lines+=['',
'## 무작위 기준선과 길이 민감도','',
'| 필드 | 참조 분포 무작위 값% (A) | 고유값 균등 무작위 값% (A) | SealQL B5 색인만 | SealQL B5 고유 길이 추가 |','|---|---:|---:|---:|---:|']
for f in fields:
 bs={r['method']:r for r in ab['baselines'] if r['field']==f and r['known']==0}
 lines.append(f'| {names[f]} | {pct(bs["random_empirical"]["pct"])} | {pct(bs["random_distinct"]["pct"])} | {pct(best(f,"S0",500)["pct"])} | {pct(best(f,"S0",500,"s0_native")["pct"])} |')
lines+=['','무작위 결과는 공격별 고정 seed와 채점 집합이 달라 소폭 다를 수 있다. A/B 전체 길이 민감도·공격별 글자 비율은 [m1-astra 원시 결과](../m1-astra/results.json), C/D 예측은 [r9-impl 결과](../r9-impl/report-ko.md)에 보존했다.','',
'## 교차 검산','',
'- 모델: 6개 필드×6개 모델×무작위32행=1,152건을 WebCrypto로 독립 계산했다. AWS의 SHA384·오른쪽 절단, CipherSweet PBKDF2, Bloom UInt16LE 배치를 공식 소스와 대조했다.','- A/B: 알려진 행 제외 분모와 모든 저장 예측 표본을 다른 프로세스에서 재실행했다.','- C/D: 전체 저장 예측의 값·글자·80% 지표를 독립 재채점하고 공격 재실행 및 관찰 hit 표본을 대조했다. D는 원문 미상 라벨 추정부터 재실행했다.','- 강화500행 표본: 전 행 재채점·표본 선택 재현·Wilson95% 구간·상한 도달 집계 및 조건별9행 공격 재실행을 통과했다. 세부 PASS 수와 파일 해시는 verify-*.json에 있다.','',
'## 대외 설명 문장과 한계','',
'“SealQL은 필드를 인증 암호화하고 행별 salt가 있는 검색 도장을 사용하지만, 결정적 검색 색인에서 생기는 통계·알려진 원문·질의 관찰 누출을 제거하지 않습니다. 동일 합성 데이터에 공개 색인 구조를 재현한 이번 실험에서는 공격 조건과 필드에 따라 복원율이 크게 달랐으며, 타 제품 대비 전반적 보안 우위를 입증하지 못했습니다.”','',
'행별 salt가 있는 도장과 값 전체의 결정적 HMAC은 같은 누출 구조가 아니다. 그러나 SealQL은 별도의 결정적 조각 토큰도 저장하므로 “salt 때문에 백업에서는 통계 공격이 불가능하다”는 설명은 잘못이다. 반대로 exact-only 색인이 부분 조각 조립 공격에 노출되지 않는 것은 지원 기능 차이이며, 부분검색 색인 전체에 대한 제품 우열로 확대할 수 없다.','',
'단일 합성 fixture·단일 키·한 번의 공격 실행이며 사전 포함률과 반복 어휘가 결과에 큰 영향을 준다. 이름·메모·이메일의 고유 접미부는 참조 사전과 겹치지 않아 전체 값 사전 공격의 0%를 만들 수 있다. API 권한·관찰 가능성은 실제 배포마다 다르다. 공격 결과는 구현한 공격의 하한이며 최적 공격·보안 확률·전체 제품 침해율이 아니다. WAL/다중 시점, 전송 암호화, enclave, 키 탈취, padding·질의 난독화 효과를 이 표로 판정하지 않는다.','',
'MongoDB Queryable Encryption은 상태 저장 구조를 신뢰성 있게 재현하지 못해 실측 비교에서 제외했다. 공식 문서는 snapshot에서 빈도 누출을 줄이는 보안 목적과 지속 접근 공격에 대한 범위 제한을 설명한다. 이 수치에서 MongoDB보다 낫거나 못하다는 결론은 내리지 않는다. [공식 보안 범위](https://www.mongodb.com/docs/manual/core/queryable-encryption/features/).','',
'## 공식 근거','',
'- AWS [길이·partition 선택](https://docs.aws.amazon.com/database-encryption-sdk/latest/devguide/choosing-beacon-length.html), [Beacon.dfy 고정 소스](https://github.com/aws/aws-database-encryption-sdk-dynamodb/blob/96d6132720b8014b8c28a051e3e7cd953d0c41bd/DynamoDbEncryption/dafny/DynamoDbEncryption/src/Beacon.dfy).','- CipherSweet [blind-index 원시 연산](https://ciphersweet.paragonie.com/internals/blind-index), [PHP FIPSCrypto](https://github.com/paragonie/ciphersweet/blob/master/src/Backend/FIPSCrypto.php), [비트 계획](https://ciphersweet.paragonie.com/php/blind-index-planning).','- CipherStash [EQL text](https://cipherstash.com/docs/reference/eql/text), [Stack 기본값 고정 소스](https://github.com/cipherstash/stack/blob/6a92634498499705da3317b78c90820ca2985f37/packages/stack/src/schema/match-defaults.ts), [core0.42.3 Bloom](https://docs.rs/crate/cipherstash-core/0.42.3/source/src/bloom_filter.rs).','- Acra [searchable encryption 보안 제어](https://docs.cossacklabs.com/acra/security-controls/searchable-encryption/).','']
headline=['## 핵심 결과','',
'전화번호는 같은 조각 조립 공격 가족으로도 차이가 컸다. 아래 SealQL은 전수, EQL match 강화는500행 표본이다. EQL 구간은95% Wilson 구간이며 계산 상태 예산 차이와 상한 도달 수는 뒤 표를 따른다.','',
'| 조건·전화번호 값 복원 | SealQL 전수% | EQL match 강화 표본% (95% 구간) |','|---|---:|---|']
for tag,known in [('B100',100),('B500',500),('C1000',None)]:
 s=next(r for r in samples['rows'] if r['tag']==tag)
 own=best('phone','S0',known)['pct'] if known is not None else next(r['strongest']['valuePct'] for r in c['results'] if (r['field'],r['model'],r['N'])==('phone','S0',1000))
 description={'B100':'알려진 원문1% (B100)','B500':'알려진 원문5% (B500)','C1000':'선택 삽입1,000회 (C1000)'}[tag]
 headline.append(f'| {description} | {pct(own)} | {pct(s["valuePct"])} ({pct(s["wilson95"][0])}–{pct(s["wilson95"][1])}) |')
headline+=['',
'이 조건에서는 SealQL의 복원율이 더 높아 누출 측면에서 불리했다. EQL match에도 선택 원문 공격이 강하게 작동했으므로 “Bloom이면 안전하다”는 결론 역시 맞지 않는다. 정확검색 전용 모델의 낮은 전화 복원율은 부분 조각을 저장하지 않는 기능 차이와 함께 읽어야 한다.','',
'회사 필드는 선택 삽입1,000회에서 SealQL·CipherSweet·EQL unique/match·Acra 모델이 모두100%, AWS3bit는68.68%였다. 이는 낮은 입력 어휘와 이 실험 설정의 결과이며 제품 전체 우열을 뜻하지 않는다. 이번 수치로 SealQL의 포괄적 보안 우위를 주장할 근거는 없다.','']
where=lines.index('## 조건과 재현 범위');lines[where:where]=headline
(OUT/'report-ko.md').write_text('\n'.join(lines),encoding='utf-8')
(OUT/'comparison.json').write_text(json.dumps({'abBest':[best(f,m,k) for f in fields for m in models for k in [0,100,500]],'chosen':c['results'],'observed':d['results']},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
checks={name:read('v-astra/'+name+'.json') for name in ['verify-models','verify-attacks-ab','verify-attacks-c','verify-observed','verify-observed-graph','verify-samples']}
digest=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
model_hash=digest('bench/competitor-sim/models.ts');attack_hash=digest('bench/competitor-sim/attacks.ts')
for v in checks.values():
 if 'modelsSourceHash' in v:assert v['modelsSourceHash']==model_hash
 if 'attackSourceHash' in v:assert v['attackSourceHash']==attack_hash
 if 'sourceHashes' in v:
  assert v['sourceHashes']['models.ts']==model_hash;assert v['sourceHashes']['attacks.ts']==attack_hash
assert ab['modelSourceHash']==model_hash and ab['attackSourceHash']==attack_hash
summary={'complete':True,'databaseAccess':False,'productCodeChanged':False,
 'modelChecks':sum(r['checks'] for r in checks['verify-models']['rows']),
 'abConditions':len(checks['verify-attacks-ab']['ab']),'abReplayedPredictions':sum(r['witnessChecks'] for r in checks['verify-attacks-ab']['ab']),
 'chosenConditions':len(checks['verify-attacks-c']['c']),'chosenScoredPredictions':sum(r['scoreChecks'] for r in checks['verify-attacks-c']['c']),'chosenReplayedPredictions':sum(r['replayChecks'] for r in checks['verify-attacks-c']['c']),
 'observedConditions':len(checks['verify-observed']['checks']),'observedScoredPredictions':sum(r['predictionsScored'] for r in checks['verify-observed']['checks']),'observedReplayedPredictions':sum(r['replayedPredictions'] for r in checks['verify-observed']['checks']),'observedHitChecks':sum(r['hitChecks'] for r in checks['verify-observed']['checks']),
 'extraObservedGraph':checks['verify-observed-graph'],'sampleConditions':len(samples['rows']),'sampleScoredRows':sum(r['scoredRows'] for r in samples['rows']),'sampleReplayedRows':sum(r['replayedRows'] for r in samples['rows']),
 'rawFixtureHash':checks['verify-models']['rawFixtureHash'],'identityDigest':checks['verify-models']['identityDigest'],
 'sourceHashes':{p:digest(p) for p in ['bench/competitor-sim/models.ts','bench/competitor-sim/attacks.ts','bench/competitor-sim/completed-phone.ts','bench/competitor-sim/observation.ts','bench/competitor-sim/m1-astra/attacks.ts']},
 'evidenceHashes':{p.as_posix():digest(p) for p in sorted(OUT.glob('verify-*.json'))},
 'limitations':['External index primitive models, not interoperable SDKs or deployed-product attacks','Single synthetic fixture and fixed key configuration','Whole-population completed attacks and 500-row strengthening reported separately','Independent model recomputation and scoring; attack predictions replay reviewed public implementations']}
(OUT/'verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('report written',len(lines),'lines')
