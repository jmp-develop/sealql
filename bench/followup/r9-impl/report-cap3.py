import json
import math
from pathlib import Path
out=Path('bench/results/2026-09-29-followup/query-tuning')
d=json.loads((out/'cap3.json').read_text(encoding='utf-8'))
assert d['complete'] and not d['errors'] and len(d['rows'])==23 and len(d['plans'])==46
def walk(n):
    yield n
    for c in n.get('Plans',[]): yield from walk(c)
def info(name,mode,path):
    p=next(p for p in d['plans'] if (p['name'],p['mode'],p['path'])==(name,mode,path))
    nodes=[n for q in p['plans'] for n in walk(q['plan'][0]['Plan'])]
    return dict(workers=max((n.get('Workers Planned',0) for n in nodes),default=0),
                launched=max((n.get('Workers Launched',0) for n in nodes),default=0),
                gin='/'.join(str(n['Plan Rows']) for n in nodes if n['Node Type']=='Bitmap Index Scan') or '없음',
                scans=','.join(dict.fromkeys(('Parallel ' if n.get('Parallel Aware') else '')+n['Node Type'] for n in nodes if 'Scan' in n['Node Type'])),
                hits=sum(q['plan'][0]['Plan'].get('Shared Hit Blocks',0) for q in p['plans']),
                reads=sum(q['plan'][0]['Plan'].get('Shared Read Blocks',0) for q in p['plans']))
for r in d['rows']:
    assert r['hits']<=r['candidates']['auto4']<=r['candidates']['cap3']
    for p in d['paths']:
        assert len(r['runs'][p])==7
        for key,value in r['summary'][p].items():
            assert math.isclose(value,sorted(x[key] for x in r['runs'][p])[3],rel_tol=1e-10,abs_tol=1e-10)
        assert r['summary'][p]['opens']==(0 if p=='plain' or r['mode']=='count' else r['returned']*6)
lines=['# 후보 토큰 최대3개: 질의 측 변형', '',
'**결론:** 큰 과소추정 조건의 원인을 완화했다. 이메일 끝 count는 534.27→170.52ms, 서비스상담은 485.01→202.22ms, 대상11개 중 200ms 초과는 11→8개다. 다만 드문 이메일 `iae` 시작은 후보6→29(4.83배), SQL0.67→0.79ms(+0.12ms)여서 “드문 검색이 느려지면 기각”이라는 엄격한 기준의 무퇴행은 충족했다고 하지 않는다. 제품 채택은 보류한다. 이 작은 시간 차이가 재현성 있는 퇴행인지 별도 반복으로 확정하지 않았으며 후보 증가 자체는 정확한 COUNT 결과다.', '',
'제품·저장 형식·정확 판정 함수를 바꾸지 않고, 생성된 SQL의 모든 `@> $n::bigint[]` 후보 배열만 줄였다. 길이 N>3이면 기존 토큰 배열의 0, floor((N−1)/2), N−1번 원소를 남긴다. 이는 **토큰 배열 순서**의 앞·중간·끝이며 원문 글자 위치 기준 선택은 아니다. 연산자·검색어별 분기는 없다. exact 꼬리 토큰과 모든 도장 키·판정은 그대로다.', '',
'## 조건과 검증', '',
'- 같은 공개 API 적재본 100,000행, 같은 물리 연결에서 평문·제품(auto4)·cap3 순서를 회전하며 첫 측정 별도+예열2+교차7회. 관계 병렬 옵션 자동, work_mem4MB, max_parallel_workers_per_gather4를 두 제품 경로에 똑같이 적용했다. 측정 락을 사용했다.',
'- 대상 count11개+회귀 count6개·목록300 6개다. 매회 전체 ID 순서와 여섯 칸 정규화 값 또는 count를 평문 원본과 대조했다. count 복호화0, 목록 실제 반환×6을 단언했다. 목록300은 여섯 칸 투영과 ID 오름차순을 유지한다.',
'- 후보 수는 시간 측정 밖에서 공개 count SQL의 정확 도장 판정만 true로 치환한 별도 COUNT다. scope와 전체 AND/OR 식을 유지하며 LIMIT 전 전체 후보 집합을 센다. 따라서 앱 전송 행 수와 다르다. 원본 후보≤cap3 후보, 정답≤양쪽 후보를 전부 단언했다.',
'- EXPLAIN(ANALYZE,BUFFERS,VERBOSE)은 각 경로 별도1회다. SQL 요청~응답과 API 전체 중앙값을 분리하며 서로 다른 지표의 중앙값을 합하지 않는다. C 로캘 한글 LIKE 평문 배율은 성능 주장에 쓰지 않는다.', '',
'## 23조건 같은 연결 비교', '',
'단위 ms, SQL/전체. worker는 EXPLAIN 계획/실제 기동 수이며 후보는 LIMIT 전 전체 집합이다.', '',
'| 조건 | 모드 | 일치/반환 | 토큰 개수(각 조건) | 후보 기존→cap3 | 평문 SQL | 기존 SQL/전체 | cap3 SQL/전체 | SQL 차이 | worker 기존→cap3 |',
'|---|---|---:|---|---:|---:|---:|---:|---:|---|']
for r in d['rows']:
    a,b=r['summary']['auto4'],r['summary']['cap3'];pa,pb=[info(r['name'],r['mode'],p) for p in ['auto4','cap3']]
    lines.append(f"| {r['name']} | {r['mode']} | {r['hits']}/{r['returned']} | {','.join(map(str,r['tokenLengths']))} | {r['candidates']['auto4']}→{r['candidates']['cap3']} | {r['summary']['plain']['sqlMs']:.2f} | {a['sqlMs']:.2f}/{a['totalMs']:.2f} | {b['sqlMs']:.2f}/{b['totalMs']:.2f} | {b['sqlMs']-a['sqlMs']:+.2f} | {pa['workers']}/{pa['launched']}→{pb['workers']}/{pb['launched']} |")
targets=[r for r in d['rows'] if r['group']=='target']
lines+=['', '| 경로 | 대상11개 중 SQL>200ms | SQL>1000ms |', '|---|---:|---:|']
for p in ['auto4','cap3']:lines.append(f"| {p} | {sum(r['summary'][p]['sqlMs']>200 for r in targets)} | {sum(r['summary'][p]['sqlMs']>1000 for r in targets)} |")
lines+=['', '## 계획과 읽기', '', '| 조건/모드 | 경로 | GIN 행 추정(각 노드) | 스캔 | shared hit/read |', '|---|---|---|---|---:|']
for r in d['rows']:
    for p in ['auto4','cap3']:
        x=info(r['name'],r['mode'],p)
        lines.append(f"| {r['name']}/{r['mode']} | {p} | {x['gin']} | {x['scans']} | {x['hits']}/{x['reads']} |")
lines+=['', '## 해석·한계', '',
'이메일 ends는 후보26,598→26,840(+0.91%)인 반면 GIN 추정82→26,840으로 바뀌고 직렬→worker3이 되었다. 서비스상담은 실제 후보29,843 그대로, GIN 추정51→3,571 및 직렬→worker2가 된다. 즉 이득은 후보를 줄였기 때문이 아니라 과소추정 완화와 병렬 계획 때문이다. 이름·회사 접두어도 직렬→worker1이 된다.', '',
'희귀 메모 count1.52→1.32ms/목록5.03→4.97ms, 0건0.52→0.48ms, 희귀 OR0.52→0.50ms다. 목록6개 중 최대 증가는 OR6의 +0.24ms다. 일반 LIKE underscore count의 +3.05ms(272.86→275.92)는 토큰이1개라 원본/변형 SQL·값·계획이 같은 대조 조건에서 관찰한 변동이며 cap3 알고리즘 효과로 단정하지 않는다. 200ms에 가까운 201–205ms 값도 임계치 미달로 포장하지 않는다.', '',
'전체 후보 토큰을 함께 보내면 상관된 조각의 빈도를 독립적으로 곱한 추정이 실제 후보 수보다 작아진다. cap3는 필요조건을 덜 보내 추정 감소를 완화한다. 후보는 늘 수 있지만 기존 도장 함수가 최종 의미를 판정하므로 정확성은 유지한다. 토큰·키의 새 종류나 저장 정보는 추가하지 않지만 공격 모형 전체를 새로 인증한 실험은 아니다.', '',
'동시 부하·다른 키/자료/ID 순서·대량 희귀 자연어는 미검증이다. 관계 workers4와 cap3를 조합하지 않았다. 이 23개만으로 모든 드문 검색의 퇴행 없음을 주장할 수 없다. 제품 변경은 하지 않았다. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.', '',
'## 재현', '',
'`node --import tsx bench/followup/r9-impl/cap3.ts`, `npx tsc -p bench/followup/r9-impl/tsconfig.json`, `python bench/followup/r9-impl/report-cap3.py`. 실제 완료 출력: `COMPLETE cap3 comparison`. [원시 지표·계획](cap3.json), [적재](load.json), [관계 옵션 실험](report-ko.md), [정리](cleanup.json).']
(out/'cap3-report-ko.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('PASS: 23 cap3 jobs, 46 plan groups, candidate monotonicity, 7 medians, opens')
