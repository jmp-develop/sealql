import json
import math
import statistics
from pathlib import Path
out=Path('bench/results/2026-09-29-lasthour/r9-impl')
d=json.loads((out/'measure.json').read_text(encoding='utf-8'))
assert d['complete'] and not d['errors'] and len(d['rows'])==114 and len(d['plans'])==570
paths=['P0','P1','P2','P3','P4']
def walk(n):
    yield n
    for c in n.get('Plans',[]):yield from walk(c)
plans={}
def nested_startup(path):
    p=next(p for p in d['plans'] if (p['name'],p['mode'],p['path'])==('nested3','list300',path))
    nodes=[n for q in p['plans'] for n in walk(q['plan'][0]['Plan'])]
    relevant=[n for n in nodes if n['Node Type']=='Gather Merge'] if path!='P0' else [n for n in nodes if n['Node Type']=='Index Scan' and n.get('Relation Name')=='customers_seal_index']
    return f"{relevant[-1]['Actual Startup Time']:.3f}ms" if relevant else '해당 노드 없음'
for p in d['plans']:
    nodes=[n for q in p['plans'] for n in walk(q['plan'][0]['Plan'])]
    plans[p['name'],p['mode'],p['path']]={'workers':max((n.get('Workers Planned',0) for n in nodes),default=0),'launched':max((n.get('Workers Launched',0) for n in nodes),default=0),'hits':sum(q['plan'][0]['Plan'].get('Shared Hit Blocks',0) for q in p['plans']),'reads':sum(q['plan'][0]['Plan'].get('Shared Read Blocks',0) for q in p['plans']),'scans':','.join(dict.fromkeys(('Parallel ' if n.get('Parallel Aware') else '')+n['Node Type'] for n in nodes if 'Scan' in n['Node Type'])),'ginEstimate':[n['Plan Rows'] for n in nodes if n['Node Type']=='Bitmap Index Scan']}
for r in d['rows']:
    orders=[o['paths'] for o in r['orders'] if 0<=o['round']<6]
    assert len(orders)==6
    pairs=[(a,b) for order in orders for a,b in zip(order,order[1:])]
    assert len(pairs)==30 and len(set(pairs))==30
    for position in range(6):assert len({order[position] for order in orders})==6
    assert r['hits']<=r['candidates']['P0']<=r['candidates']['P1']
    assert r['candidates']['P0']==r['candidates']['P2']==r['candidates']['P3']==r['candidates']['P4']
    for p in d['paths']:
        assert len(r['runs'][p])==7
        for key,value in r['summary'][p].items():assert math.isclose(value,statistics.median(x[key] for x in r['runs'][p]),rel_tol=1e-10,abs_tol=1e-10)
        assert r['summary'][p]['opens']==(0 if p=='plain' or r['mode']=='count' else r['returned']*6)
summary={}
for mode in ['all','count','list300']:
    rows=[r for r in d['rows'] if mode=='all' or r['mode']==mode]
    summary[mode]={}
    for path in paths:
        vals=[r['summary'][path]['sqlMs'] for r in rows];totals=[r['summary'][path]['totalMs'] for r in rows]
        worst=max(rows,key=lambda r:r['summary'][path]['sqlMs']-r['summary']['P0']['sqlMs'])
        relative=max(rows,key=lambda r:r['summary'][path]['sqlMs']/r['summary']['P0']['sqlMs'])
        summary[mode][path]={'n':len(rows),'meanSqlMs':statistics.mean(vals),'medianSqlMs':statistics.median(vals),'meanTotalMs':statistics.mean(totals),'medianTotalMs':statistics.median(totals),'above200':sum(v>200 for v in vals),'above1000':sum(v>1000 for v in vals),'maxSqlMs':max(vals),'worstAbsolute':{'name':worst['name'],'mode':worst['mode'],'deltaMs':worst['summary'][path]['sqlMs']-worst['summary']['P0']['sqlMs'],'ratio':worst['summary'][path]['sqlMs']/worst['summary']['P0']['sqlMs']},'worstRatio':{'name':relative['name'],'mode':relative['mode'],'deltaMs':relative['summary'][path]['sqlMs']-relative['summary']['P0']['sqlMs'],'ratio':relative['summary'][path]['sqlMs']/relative['summary']['P0']['sqlMs']},'parallelLaunched':sum(plans[r['name'],r['mode'],path]['launched']>0 for r in rows)}
(out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
baseline=summary['all']['P0']['meanSqlMs']
lines=['# 마지막 질의 측 후보 전체 회귀', '',
'**114개 비교와 모든 평문 대조를 완료했다.** 제품에는 적용하지 않았다. 아래는 동일 가중치 평균, 조건별 회귀, 후보 읽기 범위를 함께 보는 선택지이며 모든 질의의 무퇴행을 뜻하지 않는다.', '',
'| 선택지 | 전체 SQL 평균/현재 | 장점 | 대가·한계 |', '|---|---:|---|---|',
f"| P0 유지 | {baseline:.2f}ms / 1.000 | 변경·추가 함수 없음 | 상관된 토큰의 후보 과소추정이 남음 |",
f"| P1 cap3 | {summary['all']['P1']['meanSqlMs']:.2f}ms / {summary['all']['P1']['meanSqlMs']/baseline:.3f} | 간단한 질의 변화로 큰 과소추정 완화 | GIN/heap 후보가 늘 수 있고 다른 키·희귀 자연어는 미검증 |",
f"| P2 cap3+잔여 검사 | {summary['all']['P2']['meanSqlMs']:.2f}ms / {summary['all']['P2']['meanSqlMs']/baseline:.3f} | 도장 판정 전 후보 집합을 현재와 같게 유지 | 비인라인 함수 비용·LIMIT 병렬 계획 회귀; 최초 heap 후보 증가는 남음 |",
f"| P3 P2+workers4 | {summary['all']['P3']['meanSqlMs']:.2f}ms / {summary['all']['P3']['meanSqlMs']/baseline:.3f} | 여러 대량 count의 병렬 처리 | 함수 비용에 작은 작업의 worker 시작 비용도 추가 |",
f"| P4 현재+workers4 | {summary['all']['P4']['meanSqlMs']:.2f}ms / {summary['all']['P4']['meanSqlMs']/baseline:.3f} | 관계 옵션만 바꾸는 단순 후보 | 심한 과소추정은 그대로이고 작은 count 일부 악화 |", '',
f"P1은 전체 SQL 평균을 {(1-summary['all']['P1']['meanSqlMs']/baseline)*100:.1f}% 줄이고 목록 평균은 {summary['list300']['P0']['meanSqlMs']:.2f}→{summary['list300']['P1']['meanSqlMs']:.2f}ms다. P3는 전체 평균을 {(1-summary['all']['P3']['meanSqlMs']/baseline)*100:.1f}% 줄이고 200ms 초과를 {summary['all']['P0']['above200']}→{summary['all']['P3']['above200']}개로 줄이지만, 전체 SQL 중앙값은 {summary['all']['P0']['medianSqlMs']:.2f}→{summary['all']['P3']['medianSqlMs']:.2f}ms, 목록 평균은 {summary['list300']['P0']['meanSqlMs']:.2f}→{summary['list300']['P3']['meanSqlMs']:.2f}ms로 악화된다. 대량 count 이득과 작은 질의·목록 비용의 교환을 숨기지 않는다. 다섯 경로 모두 1초 초과는0개다.", '',
'저장 형식·도장 키·암호화 본문은 다섯 경로에서 같다. P1의 토큰 전송 감소를 보안 개선이라고 단정하지 않으며, P2/P3는 잔여 토큰까지 모두 전송한다. 보안 효과는 별도 담당자의 관찰 공격 결과와 함께 판단해야 한다.', '',
'## 비교 조건', '',
f"- 공개 API 적재본 100,000행, 빌드 기준 `{d['load']['commit']}`, 기존55조건+일반 LIKE2조건 각각 count/목록300으로114개다. 원본 fixture는 읽기만 했고 제품 코드는 바꾸지 않았다. [적재 근거](../v-astra/load.json).",
'- 같은 물리 연결에서 평문과 P0~P4를 최초1회 별도, 예열2회, Williams 균형 순서6회+기준 역순1회로 교차7회 비교했다. 첫6회에 각 경로는 각 위치에1회씩 오고, 경로 사이30개 방향 있는 선행 관계가 각각1회 등장함을 검사했다. 모든 실행에서 count 또는 ID 순서·6칸 전체 정규화 투영을 평문과 대조했다. count 복호화0, 목록 실제 반환×6을 매번 확인했다.',
'- P0=현재/자동병렬, P1=cap3/자동병렬, P2=cap3+나머지 토큰 함수검사/자동병렬, P3=P2+관계workers4, P4=현재+관계workers4. work_mem4MB와 max_parallel_workers_per_gather4는 전 경로 동일하다. 관계 옵션 변경은 측정 밖에서 수행하고 마지막에 복원했다.',
'- cap3는 기존 토큰 배열의0·floor((N−1)/2)·N−1번을 고른다. 원문 글자 순서 선택이 아니며 연산자별 특례가 없다. 제품 토큰 배열은 토큰 정수 오름차순이므로 다른 키에서는 선택되는 조각이 달라질 수 있다. 길이3이하는 그대로다. P2/P3는 나머지를 PL/pgSQL sealql_has_all로 검사한다. IMMUTABLE STRICT PARALLEL SAFE, SET search_path=pg_catalog, COST100(PL/pgSQL 기본값)이며 내부는 pg_catalog.@> 하나다. SQL 인라이닝을 쓰지 않는다. 도장 함수 COST1900보다 싼 잔여 토큰 검사를 먼저 배치할 수 있게 한 일반 경로다.',
'- **P2/P3는 나머지 토큰도 DB에 보내므로 전송 토큰 총량이 P0와 같다.** 도장 키·저장물·암호 형식은 모든 경로에서 같다. 이 보고는 성능·정확성 검증이며 누출 감소 인증이 아니다.',
'- 후보는 시간 측정 밖 별도 COUNT로 잰 전체 scope의 LIMIT 전 집합이다. 정확 도장 검사만 제거하고 AND/OR 구조를 유지한다. P1 후보는 P2/P3의 잔여 토큰 검사 전 후보이기도 하다. 잔여 검사 뒤는 P0와 같음을57조건 모두 단언했다. 이는 앱 전송 행 수가 아니다.',
'- 각 조건/경로의 EXPLAIN(ANALYZE,BUFFERS,VERBOSE) 별도1회, SQL 요청~응답·전체 시간·SQL 회수·앱 응답 행·복호화 수를 보존했다. 중앙값은 지표마다 독립적이며 합산하지 않는다. C 로캘 한글 LIKE 평문 배율은 성능 주장에 쓰지 않는다.', '',
'- 모든 후보 배열이3개 이하인 조건은 P0/P1/P2의 SQL·전송 값이 같아 대조군 역할을 한다. 이 조건들에서도 관측되는 작은 시간 차이는 토큰 축소 효과로 해석하지 않는다. 아래 표의 실제 수치를 선택적으로 제거하지는 않았다.', '',
'- [제외한 예비42조건](excluded-cyclic-order.json)은 단순 순환 순서여서 P0가 주로 평문 전체 스캔 직후에 실행됐다. 동일 SQL의 P0/P1에서 큰 차이를 발견해 상대 선행 순서를 균형화하고 전부 다시 측정했다. 예비 값은 아래 평균·판정에 포함하지 않았다.', '',
'- 이어진 균형 순서 실행도100조건 뒤 Windows 결과 파일 덮어쓰기 오류로 중단됐다. [중단된100조건·500계획](excluded-write-interruption.json)은 보존하고 최종 통계에서 제외했다. 저장을 임시 파일 작성 후 교체 방식으로 고친 뒤 전체114조건을 한 연결에서 다시 실행했다. 저장·DDL·후보 COUNT·EXPLAIN은 SQL 시간 측정 구간 밖이다.', '',
'## 판정 지표', '',
'각 질의 중앙값을 동일 가중치로 평균/중앙값 낸 값이며 실제 서비스 빈도 가중 평균이 아니다. 단위 ms, 임계치는 SQL 왕복 기준이다.', '',
'| 묶음 | 경로 | SQL 평균/중앙값 | 전체 평균/중앙값 | >200ms | >1000ms | 최대SQL | 병렬실행 조건 수 |', '|---|---|---:|---:|---:|---:|---:|---:|']
for mode,ps in summary.items():
    for p,x in ps.items():lines.append(f"| {mode}({x['n']}) | {p} | {x['meanSqlMs']:.2f}/{x['medianSqlMs']:.2f} | {x['meanTotalMs']:.2f}/{x['medianTotalMs']:.2f} | {x['above200']} | {x['above1000']} | {x['maxSqlMs']:.2f} | {x['parallelLaunched']} |")
lines+=['', '| 경로 | 절대 최대 악화 조건 | 증가ms/배수 | 배수 최대 악화 조건 | 증가ms/배수 |', '|---|---|---:|---|---:|']
for p in paths[1:]:
    a,b=summary['all'][p]['worstAbsolute'],summary['all'][p]['worstRatio'];lines.append(f"| {p} | {a['name']}/{a['mode']} | {a['deltaMs']:+.2f}/{a['ratio']:.2f} | {b['name']}/{b['mode']} | {b['deltaMs']:+.2f}/{b['ratio']:.2f} |")
lines+=['', '## 원인별 해석', '',
'잔여 토큰 함수가 도장보다 앞에 놓이는 것은 EXPLAIN 필터에서 확인했다. 그러나 그 사실만으로 전체 비용이 줄지는 않는다.', '',
'| 원인 | 확인된 계획·후보 근거 | 의미 |', '|---|---|---|',
'| cap3의 과소추정 완화 | 이메일 ends·서비스상담의 GIN 추정이 커져 병렬 계획 선택 | 필요조건을 덜 보내 후보가 조금 늘어도 대량 판정의 병렬화 이득 가능 |',
'| 잔여 검사 자체 비용 | 주소 세종대로 후보16,574·45자 후보2,440은 P0/P1/P2가 같음; P2는 추가 함수만 실행 | 후보 감소 없는 조건에서는 비용이 순증; fallback 후보/판정 두 단계의 기존 토큰 조건을 바꿔 잔여 함수도 반복됨 |',
f"| 작은 LIMIT의 병렬 시작 비용 | 중첩 목록 P0는 직렬 Index Scan, P2는 worker1 Gather Merge, P3는 worker4; nested3 fallback은 최종21행만 필요 | 별도 EXPLAIN에서 P2 Gather Merge 시작{nested_startup('P2')}/P3 {nested_startup('P3')}, P0 Index Scan 시작{nested_startup('P0')}. 중첩 목록 회귀는 함수 실행 수만으로 설명되지 않고 계획 변화가 주원인 |",
'| 관계 workers4의 범용 비용 | 모순3조건 count는 P0 직렬에 비해 P3/P4 병렬 시작 | 흔한 count의 이득과 작은 후보·0건 회귀를 함께 비교해야 함 |', '',
'위 EXPLAIN 시간은 별도1회이며 SQL 중앙값에서 빼거나 함수1회 비용으로 환산하지 않는다. P2/P3가 최종 후보 집합을 P0와 같게 유지함은 확인했지만, 후보를 이미 heap에서 읽은 뒤 잔여 검사를 하므로 최초 GIN/heap 읽기까지 P0와 같게 보장하는 것은 아니다.', '',
'## 114조건 전체', '', '단위 SQL/전체 ms. worker는 계획/실제 기동 수다. P2/P3 후보는 잔여 토큰 검사 후이고, 검사 전은 P1과 같다.', '', '| 조건 | 모드 | 정답/반환 | 후보P0/P1/P2 | 평문SQL | P0 SQL/전체 | P1 SQL/전체 | P2 SQL/전체 | P3 SQL/전체 | P4 SQL/전체 | worker P0/P1/P2/P3/P4 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|']
for r in d['rows']:
    cells=[f"{r['summary'][p]['sqlMs']:.2f}/{r['summary'][p]['totalMs']:.2f}" for p in paths]
    workers=[f"{plans[r['name'],r['mode'],p]['workers']}/{plans[r['name'],r['mode'],p]['launched']}" for p in paths]
    lines.append(f"| {r['name']} | {r['mode']} | {r['hits']}/{r['returned']} | {r['candidates']['P0']}/{r['candidates']['P1']}/{r['candidates']['P2']} | {r['summary']['plain']['sqlMs']:.2f} | {' | '.join(cells)} | {' · '.join(workers)} |")
lines+=['', '## 실행 계획', '', '모든570계획의 SQL·필터 평가 순서·버퍼·행 추정은 [원시 결과](measure.json)에 있다. 아래는 긴0건/45자·흔한값·희귀 조건의 count 계획이다.', '', '| 조건 | 경로 | GIN 추정 | 스캔 | shared hit/read |', '|---|---|---|---|---:|']
focus={'zero_fragment_long','sub45','zero_or_all','zero_and_common2','ends','word_boundary','affix_startsWith_email','sub_rare'}
for r in d['rows']:
    if r['mode']!='count' or r['name'] not in focus:continue
    for p in paths:
        x=plans[r['name'],r['mode'],p];lines.append(f"| {r['name']} | {p} | {'/'.join(map(str,x['ginEstimate'])) or '없음'} | {x['scans']} | {x['hits']}/{x['reads']} |")
lines+=['', '## 재현·한계', '',
'적재 완료 후 `node --import tsx bench/lasthour/r9-impl/run.ts`, `python bench/lasthour/r9-impl/report.py`, `npx tsc -p bench/lasthour/r9-impl/tsconfig.json`, `npm run docs:check`. 메모리 전용 `node --import tsx bench/lasthour/r9-impl/verify-variants.ts`의8,188개 진리표 검사는 P1 필요조건·P2 원래 조건 동치, 중첩 proof 제거, 입력/도장 파라미터 보존을 확인했다. 종료 후 `node --import tsx bench/lasthour/r9-impl/cleanup.ts`로 인계받은 임시 스키마를 삭제했다. [요약](summary.json), [임시 함수](helper.json), [정리](cleanup.json).', '',
'실제 완료 출력: 실행기는 `COMPLETE: 114 jobs x P0-P4 plus plain, every result matches plaintext`, 결과 검사는 `PASS: 114 jobs, 570 plans, 7 medians each, P2=P0 candidates, plaintext and opens`, 메모리 검사는 `PASS: 8188 candidate/rest truth-table checks; nested proof removal; input and proof parameters preserved`다. 타입 검사 exit0, docs:check의 문서·링크·결정·exports 검사 PASS, git diff --check 통과. 정리는 `PASS: last-hour handoff schema removed`다.', '',
'같은 키·fixture·한scope·ID와 물리 순서 상관이 높은 적재본의 결과다. 동시 부하·다른 키·희귀 자연어·다른 물리 순서·다른 병렬 설정은 미검증이다. 최초 실행 때 OS 캐시를 비우지 않았다. 제품 적용은 사용자 선택 후 별도 작업이다. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.']
(out/'report-ko.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('PASS: 114 jobs, 570 plans, 7 medians each, P2=P0 candidates, plaintext and opens')
