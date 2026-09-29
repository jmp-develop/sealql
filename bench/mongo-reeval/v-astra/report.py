"""Integrate verified memory experiments. No DB or product modifications."""
import hashlib
import json
from pathlib import Path

ROOT = Path('bench/results/2026-09-30-mongo-reeval')
OLD = Path('bench/results/2026-09-30-competitor-sim')
OUT = ROOT/'v-astra'
def load(p): return json.loads(p.read_text(encoding='utf-8'))
abold=load(OLD/'m1-astra/results.json'); cold=load(OLD/'r9-impl/chosen.json'); dold=load(OLD/'r9-impl/observed.json')
cd=load(ROOT/'r9-impl/results.json'); ab={(x['field'],x['model']):x for p in (ROOT/'m1-astra').glob('ab-*.json') if (x:=load(p))}
assert cd['complete'] and len(ab)==12
checks={k:load(OUT/(k+'.json')) for k in ['verify-models','verify-ab','verify-cd','verify-delta','verify-strong']}
assert all(v['complete'] for v in checks.values())
assert not checks['verify-ab'].get('partial',False)
assert not checks['verify-delta'].get('partial',False) and len(checks['verify-delta']['files'])==12
assert not checks['verify-strong'].get('partial',False)
assert len(checks['verify-cd']['files'])==48
assert not any(r['unsupportedQueries'] for r in cd['D'])
strong=load(ROOT/'m1-astra/strong-dictionary.json'); assert strong['complete']
for r in strong['results']:
    ab[(r['field'],r['model'])]['results'].append(dict(r,channel='index'))
fields=['name','phone','address','memo','email','company']; names=dict(zip(fields,['이름','전화','주소','메모','이메일','회사']))
def fmt(x): return f'{x:.2f}'
def oldab(f,m,k,ch='index'):
    return max((r for r in abold['results'] if (r['field'],r['model'],r['known'],r['channel'])==(f,m,k,ch)),key=lambda r:r['pct'])
def newab(f,m,k,native=False):
    return max((r for r in ab[(f,m)]['results'] if r['known']==k and (native or r['channel']=='index')),key=lambda r:r['pct'])
def cnew(f,m,n): return next(r for r in cd['C'] if (r['field'],r['model'],r['N'])==(f,m,n))
def coldrow(f,m,n): return next(r for r in cold['results'] if (r['field'],r['model'],r['N'])==(f,m,n))
def dnew(f,m,mode): return next(r for r in cd['D'] if (r['field'],r['model'],r['mode'])==(f,m,mode))
def doldrow(f,m,mode): return next(r for r in dold['results'] if (r['field'],r['model'],r['mode'])==(f,m,mode))
def bestmetric(d,known=True): return max((v for k,v in d.items() if (not k.startswith('unknown') if known else k.startswith('unknown'))),key=lambda r:r['valuePct'])
def olddmetric(r,known=True):
    prefix='known' if known else 'unknown'
    return max((v for k,v in r.items() if k.startswith(prefix) and isinstance(v,dict) and 'valuePct' in v),key=lambda r:r['valuePct'])
samples=load(OLD/'v-astra/verify-samples.json')['rows']
def sample(tag):
    s=next(r for r in samples if r['tag']==tag)
    return f'{fmt(s["valuePct"])} (500행; CI {fmt(s["wilson95"][0])}–{fmt(s["wilson95"][1])}; cap {s["capped"]})'
lines=['# MongoDB식 재평가: 독립 대조·통합 결과','',
'**이번 결과는 동일 fixture의 검색 색인 누출 모형을 공격한 값 복원율이다. 실제 MongoDB 서버 전체의 침해율·보안 증명은 아니다.** C-port(평문 카운터 연구 이식)와 C-mongo(암호화 카운터·등장별 태그·substring 패딩)는 분리했다. 제품 코드·DB를 변경하지 않았다.','',
'## 전화 값 복원: 핵심 비교','',
'숫자는 정규화 전화 값 전체 복원율(%). SealQL과 C 계열은 전수, Bloom 강화는 별도 고정 seed 500행 표본이다. Bloom 95% 구간은 Wilson이며 상한(cap)도 함께 표시한다. 완료된 SealQL 조립은 행당 최대2,000,000상태, Bloom 강화·새 C 전화 탐색은20,000상태이므로 계산 예산까지 동일하지 않다. 구간은 이 fixture 표본의 불확실성이며 서비스 보안 보장 구간이 아니다.','',
'| 공격 | SealQL 전수 | C-port 전수 | C-mongo 전수 | Bloom 강화 표본 |','|---|---:|---:|---:|---|']
for k,tag in [(100,'B100'),(500,'B500')]:
    lines.append(f'| B 알려진 원문 {k}행 | {fmt(oldab("phone","S0",k)["pct"])} | {fmt(newab("phone","C-port",k,True)["pct"])} | {fmt(newab("phone","C-mongo",k,True)["pct"])} | {sample(tag)} |')
lines.append(f'| C 선택 삽입 1,000회 | {fmt(coldrow("phone","S0",1000)["strongest"]["valuePct"])} | {fmt(bestmetric(cnew("phone","C-port",1000)["metrics"])["valuePct"])} | {fmt(bestmetric(cnew("phone","C-mongo",1000)["metrics"])["valuePct"])} | {sample("C1000")} |')
lines += ['',
'전화에서 관찰한 차이는 행 간 같은 조각을 연결할 결정적 태그가 있는지와 관련된다. C 계열은 같은 조각의 다른 등장에 다른 태그를 쓰므로 알려진 행·선택 삽입 행의 태그를 피해 행에 그대로 대응시키는 공격이 막힌다. C-port의 평문 장부 빈도 누출까지 사라지는 것은 아니다. 이 결과로 최적 공격에도 안전하다고 주장하지 않는다.','',
'C-port의 초기 shape DFS는6,633행에서20,000상태 상한에 도달했다. 별도 공개 참조값 인증은9,996/10,000행에 같은 공개 형태의 서로 다른 전화2개가 있음을 보였다. C-mongo는10,000행 전부에 두 후보가 있고 초기 DFS cap도0이었다. 이는 형태 제약의 비유일성이지 전체 장부·모든 채널의 전역 일관성 증명이 아니다.','',
'## 공통 조건과 비교 경계','',
'기존 10만 fixture 중 같은 피해 10,000행·참조 10,000행을 메모리로 재생했다. ID 분할 해시는 `189a19c99711fbacd9cafdb548f243a63657e12a0c1514a736c1f92da670f382`다. 입력은 모두 앱 수준 compact 정규화다. 이전 [데이터 검산](../../2026-09-30-competitor-sim/v-astra/verify-models.json)에서 원문 10만×6필드 해시가 실제 DB 원본 읽기 기록과 일치했다. 이번에는 DB에 접속하지 않았다.','',
'C-port는 원 연구의 2..10 부분 조각+exact(주소·이메일 affix 추가), C-mongo 주비교는 6필드 substring 모형(2..10, 최대60), equality-only는 D에서 별도다. 임의 LIKE·긴 검색어·전체 API 기능 등가성은 주장하지 않는다. C-mongo의 60글자 초과 입력은 자르지 않고 제외하며 아래 분모를 공개한다. 질의는 이전 1,000회 스케줄의 최초 도착 순서를 재사용하고 반복 질의를 합친다.','',
'참조 사전에 전체값이 들어 있는 피해 비율은 이름0%·전화0%·주소82.17%·메모0%·이메일0%·회사100%다. 따라서 전체값 사전 공격의 0%만으로 판단하지 않고 전화 조립·양성/음성 질의 제약도 시험했다. 대표값은 하나의 전체 공격 실행 중 최고값이며 피해 행마다 정답을 보고 방법을 선택하지 않았다.','',
'| C-mongo substring 필드 | 지원 피해 | 미지원 피해 | B100 채점 분모 | B500 채점 분모 |','|---|---:|---:|---:|---:|']
for f in fields:
    x=ab[(f,'C-mongo')]
    lines.append(f'| {names[f]} | {10000-len(x["unsupported"])} | {len(x["unsupported"])} | {newab(f,"C-mongo",100)["rows"]} | {newab(f,"C-mongo",500)["rows"]} |')
lines += ['', '## A/B 색인만 관찰','',
'태그/비트와 그 개수를 사용한다. C-mongo의 태그 수에는 공식 수식의 패딩이 포함된다. Bloom 전화의 아래 전수값은 이전 약한 조립 알고리즘도 포함하므로 위 강화 표본과 함께 읽는다.','',
'| 필드 | 공격 | SealQL | C-port | C-mongo | Bloom |','|---|---|---:|---:|---:|---:|']
for f in fields:
    for k in [0,100,500]:
        lines.append('| '+names[f]+' | '+({0:'A 백업',100:'B 1%',500:'B 5%'}[k])+' | '+' | '.join(fmt(x) for x in [oldab(f,'S0',k)['pct'],newab(f,'C-port',k)['pct'],newab(f,'C-mongo',k)['pct'],oldab(f,'CipherStash-match',k)['pct']])+' |')
lines += ['', '## 실제 모형의 길이 정보를 함께 관찰','',
'SealQL은 이전 s0_native(원문 byte 길이·compact 글자 수), C-port는 정규화 본문 byte 길이+28, C-mongo는 암호화 BSON 길이 블록과 패딩 태그 수다. 외부 Bloom SDK 암호문 봉투를 구현하지 않아 해당 열은 없다.','',
'| 필드 | 공격 | SealQL 색인+고유 길이 | C-port 최고 | C-mongo 최고 |','|---|---|---:|---:|---:|']
for f in fields:
    for k in [0,100,500]:
        lines.append(f'| {names[f]} | {k}개 알려짐 | {fmt(max(oldab(f,"S0",k)["pct"],oldab(f,"S0",k,"s0_native")["pct"]))} | {fmt(newab(f,"C-port",k,True)["pct"])} | {fmt(newab(f,"C-mongo",k,True)["pct"])} |')
lines += ['', '## C 선택 삽입','',
'선택 삽입은 같은 범위에 넣은 정상 참조값과 저장 상태만 제공한다. 서버용 검색 파생키는 주지 않는다. 단일 최종 백업에서 다른 등장 태그의 연결이 생기는지 확인하고, 두 백업의 장부 변화는 아래 별도 표로 분리했다.','',
'| 필드 | 삽입 수 | SealQL | C-port | C-mongo | Bloom 전수 |','|---|---:|---:|---:|---:|---:|']
for f in fields:
    for n in [100,1000]:
        vals=[coldrow(f,'S0',n)['strongest']['valuePct'],bestmetric(cnew(f,'C-port',n)['metrics'])['valuePct'],bestmetric(cnew(f,'C-mongo',n)['metrics'])['valuePct'],coldrow(f,'CipherStash-match',n)['strongest']['valuePct']]
        lines.append(f'| {names[f]} | {n} | '+' | '.join(fmt(x) for x in vals)+' |')
lines += ['', '## D 질의 관찰','',
'검색어 앎/모름을 분리한다. DB 서버가 받는 질의 파생키와 접근/결과 집합을 관찰하는 전제이며 TLS 패킷만 감청한 경우가 아니다. C 모형은 관찰키로 실제 ESC 탐색·카운터 복호화·태그 열거를 수행한다. 검색어 미상은 참조 분포로 라벨을 추정하고 정답 라벨을 받지 않는다.','',
'| 필드·검색 | 필드 질의 수 | SealQL 앎/모름 | C-port 앎/모름 | C-mongo 앎/모름 | Bloom 앎/모름 |','|---|---:|---|---|---|---|']
for f in fields:
    for mode in ['eq','partial']:
        cp=dnew(f,'C-port',mode);cm=dnew(f,'C-mongo',mode);s=doldrow(f,'S0',mode)
        def pair(r,new): return '/'.join(fmt((bestmetric(r['metrics'],known) if new else olddmetric(r,known))['valuePct']) for known in [True,False])
        bloom=pair(doldrow(f,'CipherStash-match',mode),False) if mode=='partial' else '해당 없음'
        lines.append(f'| {names[f]} / {mode} | {cp["fieldObservations"]} | {pair(s,False)} | {pair(cp,True)} | {pair(cm,True)} | {bloom} |')
lines += ['', '## 두 백업과 장부','',
'두 시점은 batch 삽입·갱신 전후의 끝점이다. 개별 연산 로그/WAL 트랜잭션 그룹이나 내부 조각→ESC 연결표를 추가하지 않는다. C-port는 평문 카운터 변화에서 일부 조각 라벨을 추정할 수 있지만 그 장부 ID와 과거 피해 행 태그의 공개 JOIN은 없다. C-mongo도 압축된 anchor의 같은 ID·달라진 암호문을 관찰할 수 있으므로 “변화가 없다”고 처리하지 않았다.','',
'| 모델·필드 | 삽입1000 후 평문 counter 변화 / 암호문 변화 포함 전체 | 추정 단일 라벨 / 정답 라벨 | 알려진 태그와 피해 행 겹침 |','|---|---|---|---:|']
for f in fields:
    for m in ['C-port','C-mongo']:
        x=load(ROOT/f'm1-astra/delta-{m}-{f}.json');r=next(r for r in x['cases'] if r['operation']=='insert' and r['N']==1000 and r['phase']==('precompaction' if m=='C-port' else 'postcompaction-endpoints'));e=r['esc']
        lines.append(f'| {m} / {names[f]} | {e["plaintextCountDeltas"]} / {e["changed"]} | {e["uniqueBatchCounterLabels"]} / {e["evaluationOnlyCorrectCounterLabels"]} | {r["knownTargetTagOverlapRows"]} |')
lines += ['',
'갱신 시험은 원래 피해 행 100/1000개를 고정 참조값으로 교체하고 나머지 행을 채점했다. 한 글자만 바꾸는 상관 편집, 연산별 로그, 실제 압축/cleanup의 중간 상태는 이번 결과에 포함되지 않는다. 상세 집계는 [m1-astra 결과](../m1-astra/report-ko.md)를 따른다.','',
'## 독립 검산','',
f'- 모형: 공개 길이/패딩 {checks["verify-models"]["shapeChecks"]:,}건, WebCrypto C-port 태그 {checks["verify-models"]["cryptographicTagChecks"]:,}개, 질의 {checks["verify-models"]["queryChecks"]}회 대조 PASS.',
f'- A/B: shape 예측 {checks["verify-ab"]["shapePredictionsRescored"]:,}건을 독립 알고리즘으로 재생·재채점하고 witness {checks["verify-ab"]["witnessesRescored"]:,}건을 채점했다. 색인 전용 다른 방법의 전체 예측은 독립 재실행하지 않았으며 산술·witness 확인 범위다.',
f'- C/D: 저장 예측 {checks["verify-cd"]["predictionsRescored"]:,}건 재채점, 질의 일치집합 {checks["verify-cd"]["observationHitChecks"]:,}개 평문 대조, 미상 라벨 추정 {checks["verify-cd"]["unknownLabelReplays"]}회 재실행. 전화 graph 표본 재생 {checks["verify-cd"]["phoneReplays"]}건.',
f'- 공통 강한 사전 공격의 등장고유 경우 축약 {checks["verify-strong"]["aggregateChecks"]}조건, 예측 {checks["verify-strong"]["predictionsRescored"]:,}건을 별도 구현으로 대조했다. 공개 참조 전화 비유일성 인증 {checks["verify-strong"]["certificateRows"]:,}행도 확인했다.',
'- 검산 범위·원시 파일 SHA-256은 [verify-models.json](verify-models.json), [verify-ab.json](verify-ab.json), [verify-cd.json](verify-cd.json), [verify-delta.json](verify-delta.json)에 보존했다.','',
'## 판단과 다음 단계','',
'현재 결정적 조각 색인이 강한 알려진·선택 원문 공격에 노출된다는 판단은 유지된다. 등장별 태그와 암호화 상태를 사용하는 방향을 다시 평가할 근거가 생겼다. 다만 회사처럼 어휘가 적은 필드의 형태 누출, 질의 관찰, 다중 시점과 로그는 별도의 보호 문제가 남는다. 이번 0%는 지정 공격의 하한이며 실제 MongoDB 전체의 최대 복원율이 아니다.','',
'C-mongo는 별도 키의 ESC/EDC PRF, 암호화 counter, 패딩 수식·중복 fake, cf8을 재현한 누출 모형이다. 실제 SDK 바이트·모든 로그·암호문 검증 블록·권한·복구를 재현하지 않는다. ECOC는 불투명 문서 건수로 추상화했고 압축 후는 그룹별 암호화 anchor 끝점으로 이상화했다. 실제 BSON 태그 배열 순서(FNV 집합 순서 포함)를 버린 모델이므로 D에서 rank를 활용하는 추가 공격은 빠져 있다. 공식 근거와 고정 소스는 [모형 규칙표](model-rules-ko.md), [source-provenance.json](source-provenance.json)에 있다.','',
'성능은 이번 단계에서 새로 측정하지 않았다. [기존 증거 재계산·설계 검토](performance-review-ko.md)에서 C-port 24 count·18목록, 용량89.94배를 검산했다. 보통 count는 이미 검색 표 단독·복호화0이다. 후보 태그 열거·교집합·정렬 개선을 먼저 시험해야 하며, 결정적16비트 후보를 다시 붙여 속도를 얻으면 이번 연결 누출도 다시 도입한다. 안전한 쓰기·동시성·암호화 장부 비용까지 포함한 최종 성능 판단은 다음 실측 단계다.','',
'대외 문장: “현재 SealQL의 결정적 조각 색인은 알려진·선택 원문을 이용한 연결 공격에 취약할 수 있습니다. 같은 데이터의 등장별 태그·암호화 상태 모형에서는 해당 공격의 복원율이 낮아졌지만, 길이·질의 관찰·변경 이력의 누출을 모두 제거하지는 않으며 실제 제품의 보안 보장으로 해석할 수 없습니다.”','']
(OUT/'report-ko.md').write_text('\n'.join(lines),encoding='utf-8')
manifest={str(p).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ROOT.rglob('*.json')) if 'v-astra' not in p.parts}
(OUT/'comparison-inputs.json').write_text(json.dumps({'complete':True,'inputs':manifest,'checks':checks},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'complete':True,'report':str(OUT/'report-ko.md'),'sourceFiles':len(manifest)}))
