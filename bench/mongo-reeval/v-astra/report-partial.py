"""Preserve completed evidence after cancellation; no experiment is executed."""
import hashlib
import json
from pathlib import Path
ROOT=Path('bench/results/2026-09-30-mongo-reeval'); OLD=Path('bench/results/2026-09-30-competitor-sim'); OUT=ROOT/'v-astra'
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
fields=['name','phone','address','memo','email','company']; names=dict(zip(fields,['이름','전화','주소','메모','이메일','회사']))
abold=read(OLD/'m1-astra/results.json'); cold=read(OLD/'r9-impl/chosen.json'); dold=read(OLD/'r9-impl/observed.json')
ab={}; cs={}; ds={}; sources={}
for p in (ROOT/'m1-astra').glob('ab-*.json'):
    x=read(p)
    if x.get('complete'): ab[(x['field'],x['model'])]=x; sources[str(p).replace('\\','/')]=sha(p)
for kind,target in [('chosen',cs),('observed',ds)]:
    for p in (ROOT/'r9-impl').glob(kind+'-*.json'):
        x=read(p)
        if x.get('metrics') and x.get('predictions'):
            target[(x['field'],x['model'],x['N'] if kind=='chosen' else x['mode'])]=x; sources[str(p).replace('\\','/')]=sha(p)
checks={k:read(OUT/(k+'.json')) for k in ['verify-models','verify-ab','verify-cd','verify-delta','verify-strong']}
def fmt(x): return '미측정' if x is None else f'{x:.2f}'
def oa(f,m,k): return max(r['pct'] for r in abold['results'] if (r['field'],r['model'],r['known'],r['channel'])==(f,m,k,'index'))
def na(f,m,k,native=False):
    x=ab.get((f,m))
    return max((r['pct'] for r in x['results'] if r['known']==k and (native or r['channel']=='index')),default=None) if x else None
def oc(f,m,n): return next(r['strongest']['valuePct'] for r in cold['results'] if (r['field'],r['model'],r['N'])==(f,m,n))
def nc(f,m,n):
    r=cs.get((f,m,n)); return max(v['valuePct'] for v in r['metrics'].values()) if r else None
def od(f,m,mode,known):
    r=next(r for r in dold['results'] if (r['field'],r['model'],r['mode'])==(f,m,mode));prefix='known' if known else 'unknown'
    return max(v['valuePct'] for k,v in r.items() if k.startswith(prefix) and isinstance(v,dict) and 'valuePct' in v)
def nd(f,m,mode,known):
    r=ds.get((f,m,mode))
    return max(v['valuePct'] for k,v in r['metrics'].items() if (not k.startswith('unknown') if known else k.startswith('unknown'))) if r else None
samples=read(OLD/'v-astra/verify-samples.json')['rows']
def sample(tag):
    r=next(r for r in samples if r['tag']==tag)
    return f'{fmt(r["valuePct"])} (CI {fmt(r["wilson95"][0])}–{fmt(r["wilson95"][1])}; cap {r["capped"]})'
lines=['# 사용자 결정으로 중단, 부분 결과','',
'MongoDB 재평가는 사용자 결정으로 중단했다. 실행 중인 v-astra 검산 프로세스는 없음을 확인했고 새 실험·재검산을 시작하지 않았다. 이미 완결되어 저장된 파일만 아래 표에 옮겼다. **미완료 칸은 미측정이며 0%가 아니다.** 제품 코드·DB 변경은 없다.','',
f'보존 시점 완결 파일: A/B {len(ab)}/12, C {len(cs)}/24, D {len(ds)}/24. 개별 완결 파일과 전체 작업 완료는 구분한다. C-mongo 압축 전후 삽입·갱신의 별도 delta 실행은 미측정이다.','',
'## 핵심 전화 비교','',
'정규화 값 전체 복원율(%). S0와 C 계열은 전수, Bloom 강화는 고정 seed500행 표본과 Wilson95% 구간이다. 완료된 S0 조립은 최대2,000,000상태/행, 새 C와 Bloom 강화는20,000상태/행으로 계산 예산도 다르다.','',
'| 조건 | SealQL | C-port | C-mongo | Bloom 강화500행 |','|---|---:|---:|---:|---|']
for k,tag in [(100,'B100'),(500,'B500')]: lines.append(f'| B 알려진 {k}행 | {fmt(oa("phone","S0",k))} | {fmt(na("phone","C-port",k,True))} | {fmt(na("phone","C-mongo",k,True))} | {sample(tag)} |')
for n in [100,1000]: lines.append(f'| C 선택 삽입 {n}회 | {fmt(oc("phone","S0",n))} | {fmt(nc("phone","C-port",n))} | {fmt(nc("phone","C-mongo",n))} | {sample("C"+str(n))} |')
lines.append(f'| D 부분검색어 앎 | {fmt(od("phone","S0","partial",True))} | {fmt(nd("phone","C-port","partial",True))} | {fmt(nd("phone","C-mongo","partial",True))} | {sample("D-known")} |')
lines += ['',
'C-mongo 전화 A/B는 초기 형태 탐색에서도 두 원문 후보가 남고 cap0이었다. C-port 초기 형태 탐색은6,633행에서 상한에 닿았으나, 별도 공개 참조값 확인으로9,996행에 같은 형태의 서로 다른2값이 있음을 확인했다. 이 증거는 형태 제약의 비유일성이며 전체 장부 일관성·최적 공격에 대한 증명이 아니다. 완료된 C-mongo D 전화는 모호한9,998행·상한2행·고유반환0행이다.','',
'## A/B: 색인 관찰','',
'태그/비트와 개수만 제공한 최고 단일 공격 실행의 비율이다. 피해 행마다 정답을 보고 방법을 선택하지 않는다. Bloom 전화의 전수 알고리즘 수치는 위 강화 표본과 구분한다. B는 알려진100/500행을 제외한9,900/9,500행을 채점하며 C-mongo 미지원 입력은 추가 제외한다.','',
'| 필드 | 공격 | SealQL | C-port | C-mongo | Bloom 전수 |','|---|---|---:|---:|---:|---:|']
for f in fields:
    for k in [0,100,500]: lines.append(f'| {names[f]} | '+{0:'A',100:'B1%',500:'B5%'}[k]+' | '+' | '.join(fmt(v) for v in [oa(f,'S0',k),na(f,'C-port',k),na(f,'C-mongo',k),oa(f,'CipherStash-match',k)])+' |')
lines += ['', '## 길이·형태 추가 관찰: B5%','',
'C-port는 정규화 본문 byte길이+28, C-mongo는 암호화 BSON 길이 블록과 패딩 개수를 사용한다. 회사 등 작은 사전의 형태 누출은 전화0%와 별개다.','',
'| 필드 | C-port 색인+형태 | C-mongo 색인+형태 | C-mongo B500 분모 |','|---|---:|---:|---:|']
for f in fields:
    x=ab.get((f,'C-mongo')); n=next(r['rows'] for r in x['results'] if r['known']==500) if x else '미측정'
    lines.append(f'| {names[f]} | {fmt(na(f,"C-port",500,True))} | {fmt(na(f,"C-mongo",500,True))} | {n} |')
lines += ['', '## C: 선택 삽입','',
'같은 범위에 정상 참조값을 선택 삽입하는 상황을 메모리 모형으로 재현하고 저장 상태만 관찰했다. 서버용 질의 키는 제공하지 않았다.','',
'| 필드 | 횟수 | SealQL | C-port | C-mongo | Bloom 전수 |','|---|---:|---:|---:|---:|---:|']
for f in fields:
    for n in [100,1000]: lines.append(f'| {names[f]} | {n} | '+' | '.join(fmt(v) for v in [oc(f,'S0',n),nc(f,'C-port',n),nc(f,'C-mongo',n),oc(f,'CipherStash-match',n)])+' |')
lines += ['', '## D: 질의 관찰','',
'숫자는 검색어 앎/모름. 이전1000회 전역 스케줄을 재사용했다. 이는 DB가 받는 질의 파생키·접근집합을 보는 공격이며 TLS 패킷만 감청한 경우가 아니다. C는 관찰키로 ESC 탐색·카운터 복호화·태그 열거를 수행한다.','',
'| 필드·검색 | SealQL 이전 공격 | C-port | C-mongo | Bloom 이전 공격 |','|---|---|---|---|---|']
for f in fields:
    for mode in ['eq','partial']:
        pair=lambda fn:'/'.join(fmt(fn(k)) for k in [True,False])
        lines.append(f'| {names[f]} / {mode} | {pair(lambda k:od(f,"S0",mode,k))} | {pair(lambda k:nd(f,"C-port",mode,k))} | {pair(lambda k:nd(f,"C-mongo",mode,k))} | '+(pair(lambda k:od(f,'CipherStash-match',mode,k)) if mode=='partial' else '해당 없음')+' |')
lines += ['',
'**D의 공격 가족 차이:** 새 C에는 질의+공개 형태 결합 공격을 추가했지만 위 S0/Bloom은 이전 실행이다. 특히 회사 미상 질의의 C-port70.70%와 S0 50.63% 차이를 구조의 보안 우열로 해석하면 안 된다. S0 보강 파일은 normalized byte길이를 raw 암호문 길이처럼 사용한 경계 문제를 검토 중 중단되어 통합 채택하지 않았다. 해당 수정·동등 공격 비교는 미완료다.','',
'## 장부와 두 시점','',
'C-port 두 시점 삽입/갱신100·1000회는6필드24조건이 완료됐다. 알려진 새 행 태그와 변하지 않은 피해 행 태그의 겹침은0이었다. 평문 counter의 변화와 일부 조각 라벨 추정은 가능하나 ESC ID와 과거 피해 행 태그의 공개 연결표는 없다. C-mongo 별도 delta 실행은 미측정이며 C100 전화 파일의 끝점 집계만 존재한다. 개별 연산별 WAL·압축 로그 트랜잭션 그룹 공격은 미측정이다.','',
'C-port 백업 장부의 빈도 공격은 피해 행 복원과 별개로, 상위100개 익명 counter의 조각 라벨을 이름1·전화3·주소3·메모4·이메일4·회사10개 맞혔다. 이 추가 집계는 담당자의 [ledger-frequency.json](../m1-astra/ledger-frequency.json)에 있으며 v-astra 전수 독립 재실행 전 중단했다.','',
'## 교차 검산 완료 범위','',
f'- 모형:120,000 shape·11,166 WebCrypto 태그·300 query PASS. [verify-models.json](verify-models.json).',
f'- A/B:{len(checks["verify-ab"]["files"])}개 파일, shape 예측 {checks["verify-ab"]["shapePredictionsRescored"]:,}건 독립 재생, witness {checks["verify-ab"]["witnessesRescored"]:,}건 채점. [verify-ab.json](verify-ab.json). 색인 전용 다른 방법은 산술/witness 확인 범위다.',
f'- C/D:{len(checks["verify-cd"]["files"])}개 C-port 파일, 예측 {checks["verify-cd"]["predictionsRescored"]:,}건 재채점·관찰 {checks["verify-cd"]["observationHitChecks"]:,}개 평문 대조·미상 라벨 추정12회·전화 graph7행 재생. [verify-cd.json](verify-cd.json). C-mongo C/D의 완결 파일2개는 독립 검산 전 중단했다.',
f'- 두 시점:C-port24조건·예측 {checks["verify-delta"]["predictionsRescored"]:,}건 독립 재채점. [verify-delta.json](verify-delta.json). 암호문 delta 전체는 재생하지 않았다.',
f'- 강한 사전 축약:21조건·205,800예측과 공개 참조 전화 형태 증거19,996행을 검산했다. [verify-strong.json](verify-strong.json). 이후 내부exact/fake 특징을 보강한 수정판은 독립 재검산 전 중단했다.','',
'완결 A/B11개 중 v-astra 독립 검산은8개까지다. 나중에 완료된 C-mongo 이름·메모·이메일3개는 담당자 계산 결과이며 독립 검산 전 중단했다. 검산 JSON의 complete는 **그 실행에 입력된 파일 집합** 완료를 뜻하며 전체 과제 완료가 아니다.','',
'## 재현 경계와 성능 검토','',
'같은 피해1만·참조1만,6필드, 앱 compact 정규화를 사용했다. 전체값 참조 포함률은 이름0%·전화0%·주소82.17%·메모0%·이메일0%·회사100%다. C-mongo 주모형은substring2..10·최대60글자이며 초과 입력은 잘라내지 않고 제외했다. 메모 피해26행이 미지원이라 A9974/B1009874/B5009475행을 채점했다. 정확검색 profile은 별도이며 임의LIKE·긴검색어를 포함한 전체기능등가 비교는 아니다.','',
'C-port는 평문 카운터·64bit 태그 연구 이식이다. C-mongo는 별도 ESC/EDC PRF·암호화 counter·cf8·공식 패딩 수식과 반복 fake를 반영한 **누출 모형**이다. SDK 바이트·실제 서버 전체의 재현이 아니며 ECOC는 불투명 문서 건수로 추상화하고 압축 후는 숨겨진 그룹별 암호화 anchor로 이상화했다. 실제 BSON 태그 배열의 FNV 순서 채널, 로그, 중간 compaction/cleanup, 복구·동시성은 재현하지 않았다. 공식 근거와 고정 소스는 [규칙표](model-rules-ko.md), [소스 해시](source-provenance.json)에 있다.','',
'[기존 C 성능 재계산](performance-review-ko.md)은24 count·18목록과 용량89.94배를 확인했다. 일반 count는 이미 검색 표 단독·복호화0이므로 부모JOIN 제거를 새 이득으로 중복 계산할 수 없다. 등장태그 생성·교집합·정렬 최적화는 후보이나 새 성능 측정은 하지 않았다. 결정적16bit 후보를 다시 붙이면 기존 연결 누출을 되살릴 수 있다.','',
'**부분 결론:** 완료한 전화 백업·알려진 원문 조건에서는 등장별 태그 모형의 복원율이 현재 결정적 조각 색인보다 낮았다. 그러나 미완료 C-mongo 조건을 채우거나 전체 제품 보안 우위를 확정하지 않는다. 0%는 해당 데이터와 구현한 공격의 실패이며 안전성 증명이 아니다.','']
(OUT/'report-ko.md').write_text('\n'.join(lines),encoding='utf-8')
(OUT/'partial-inputs.json').write_text(json.dumps({'status':'stopped_by_user','partial':True,'completedFileCounts':{'AB':len(ab),'C':len(cs),'D':len(ds)},'inputHashes':sources,'verificationFiles':{k:sha(OUT/(k+'.json')) for k in checks}},indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':'stopped_by_user','AB':len(ab),'C':len(cs),'D':len(ds),'report':'bench/results/2026-09-30-mongo-reeval/v-astra/report-ko.md'}))
