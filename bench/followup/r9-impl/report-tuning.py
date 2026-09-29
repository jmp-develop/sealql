import json
import math
from pathlib import Path
out=Path('bench/results/2026-09-29-followup/query-tuning')
d=json.loads((out/'measure.json').read_text(encoding='utf-8'))
load=json.loads((out/'load.json').read_text(encoding='utf-8'))
assert d['complete'] and not d['errors'] and load['complete'] and load['loaded']==100000
assert len(d['rows'])==23 and len(d['plans'])==92
paths=['auto4','parallel4','auto32','parallel32']
for r in d['rows']:
    for p in d['paths']:
        assert len(r['runs'][p])==7
        for key,value in r['summary'][p].items():
            expected=sorted(x[key] for x in r['runs'][p])[3]
            assert math.isclose(value,expected,rel_tol=1e-10,abs_tol=1e-10)
        assert r['summary'][p]['opens']==(0 if p=='plain' or r['mode']=='count' else r['returned']*6)
def walk(n):
    yield n
    for p in n.get('Plans',[]): yield from walk(p)
def plan_info(record):
    nodes=[n for p in record['plans'] for n in walk(p['plan'][0]['Plan'])]
    scans=[n for n in nodes if 'Scan' in n['Node Type']]
    return {'scans':','.join(dict.fromkeys(('Parallel ' if n.get('Parallel Aware') else '')+n['Node Type'] for n in scans)),
            'workers':max((n.get('Workers Planned',0) for n in nodes),default=0),
            'launched':max((n.get('Workers Launched',0) for n in nodes),default=0),
            'exact':sum(n.get('Exact Heap Blocks',0) for n in nodes),
            'lossy':sum(n.get('Lossy Heap Blocks',0) for n in nodes),
            'recheck':sum(n.get('Rows Removed by Index Recheck',0) for n in nodes),
            'est':sum(n.get('Plan Rows',0) for n in nodes if n['Node Type']=='Bitmap Index Scan'),
            'actual':sum(n.get('Actual Rows',0)*n.get('Actual Loops',1) for n in nodes if n['Node Type']=='Bitmap Index Scan')}
targets=[r for r in d['rows'] if r['group']=='target']
lines=['# 검색 표 병렬 정책·work_mem 후속 실측', '',
'**결론:** 관계 workers=4는 대상11개 중 200ms 초과를 11→8개로 줄였으나 AND6 count는 30.42→34.71ms로 4.29ms 늘었다. 효과는 일부 계획의 직렬→병렬 또는 worker2→4 변경에서 왔으며, 후보 과소추정이 심한 이메일·서비스상담에는 효과가 없었다. work_mem32MB의 일괄 개선은 확인하지 못했다. 제품에는 적용하지 않았다. 후속 질의 측 변형은 [후보 토큰 최대3개 비교](cap3-report-ko.md)를 본다.', '',
'저장 데이터·제품 코드·판정 함수는 바꾸지 않고, 새 검색 표의 `parallel_workers` 관계 옵션과 측정 연결의 `work_mem`만 비교했다. 결과는 같은 연결의 교차 중앙값이며 로컬 합성 fixture 결과다. 운영 보장·보안 인증이 아니다.', '',
'## 조건', '',
f"- HEAD `{load['commit'][:7]}` 빌드 후 공개 `sealed.insert`로 원본 fixture 100,000행을 새 자기 스키마에 적재했다. 적재는 네 개의 500행 배치를 병렬로 진행했으며 적재 경과 시간은 성능 벤치로 사용하지 않는다. 부모/검색 표 각각 100,000행과 표본 600개 칸 인증 복호화를 확인했다.",
'- 한 scope, 동일한 물리 데이터·연결·질의·ID 오름차순·목록300·6개 칸 투영을 사용했다. 처음 1회 별도, 예열2회, 순서 회전 교차7회다. 매회 count와 목록의 ID·전체 정규화 투영을 원본 평문과 대조했다.',
'- 네 제품 경로는 auto4(자동 병렬·4MB), parallel4(관계 workers=4·4MB), auto32(자동 병렬·32MB), parallel32(workers=4·32MB)다. 모든 경로의 연결 `max_parallel_workers_per_gather=4`를 고정했다. 관계 옵션·GUC 변경은 측정 구간 밖에서 수행했다. 원래 서버 설정과 행/ID 상관은 원시 결과에 있다.',
'- 최종 재측정에서 200ms를 넘었던 count9개와 일반 LIKE2개, 별도 count6개·목록6개 회귀 조건이다. 평문도 같은 연결에서 측정했다. C 로캘 한글 LIKE는 전체 스캔이므로 평문 배율을 성능 주장에 쓰지 않는다.',
'- SQL 요청~응답과 API 전체 시간을 분리했다. 지표별 중앙값은 더해서 다른 중앙값이 되지 않는다. count는 인증 복호화0, 목록은 실제 반환 칸만 복호화함을 매번 단언했다. 최초 실행은 OS 캐시를 비우지 않아 cold라고 부르지 않는다.', '',
'## 200ms 초과 대상 count', '', '| 조건 | 일치 | plain SQL | auto4 SQL/전체 | parallel4 SQL/전체 | auto32 SQL/전체 | parallel32 SQL/전체 |', '|---|---:|---:|---:|---:|---:|---:|']
for r in targets:
    cells=[f"{r['summary'][p]['sqlMs']:.1f}/{r['summary'][p]['totalMs']:.1f}" for p in paths]
    lines.append(f"| {r['name']} | {r['hits']} | {r['summary']['plain']['sqlMs']:.1f} | {' | '.join(cells)} |")
lines += ['', '| 경로 | 대상11개 중 SQL>200ms | SQL>1000ms |', '|---|---:|---:|']
for p in paths: lines.append(f"| {p} | {sum(r['summary'][p]['sqlMs']>200 for r in targets)} | {sum(r['summary'][p]['sqlMs']>1000 for r in targets)} |")
lines += ['', '## 드문값·0건·목록 회귀', '', '| 조건 | 모드 | 일치/반환 | auto4 SQL/전체 | parallel4 SQL/전체 | auto32 SQL/전체 | parallel32 SQL/전체 |', '|---|---|---:|---:|---:|---:|---:|']
for r in d['rows']:
    if r['group']!='guard': continue
    cells=[f"{r['summary'][p]['sqlMs']:.2f}/{r['summary'][p]['totalMs']:.2f}" for p in paths]
    lines.append(f"| {r['name']} | {r['mode']} | {r['hits']}/{r['returned']} | {' | '.join(cells)} |")
lines += ['', '## EXPLAIN 근거', '',
'각 경로에서 별도 `EXPLAIN (ANALYZE,BUFFERS,VERBOSE,FORMAT JSON)` 1회를 수집했다. 아래 heap 블록·재검사 탈락은 계획 노드에 출력된 값이며 병렬 worker 전체 합이라고 주장하지 않는다. 후보는 앱으로 전송되지 않으므로 SQL 응답 행 수와 혼동하지 않는다. 상세 조건·버퍼·행 추정은 원시 계획을 본다.', '',
'| 조건/모드 | 경로 | 스캔 | worker 계획/기동 | heap exact/lossy | recheck 탈락 | GIN 추정/실제 행 |', '|---|---|---|---:|---:|---:|---:|']
focus={'ends','word_boundary','like_general_segments','like_general_underscore','sub_rare','sub_zero','nested3','affix_startsWith_name','affix_startsWith_company','sub_common_memo','and6'}
for p in d['plans']:
    if p['name'] not in focus or p['mode']!='count': continue
    x=plan_info(p)
    lines.append(f"| {p['name']}/{p['mode']} | {p['path']} | {x['scans']} | {x['workers']}/{x['launched']} | {x['exact']}/{x['lossy']} | {x['recheck']} | {x['est']}/{x['actual']} |")
lines += ['', '이메일 ends는 GIN 후보 추정82/실제26,598이며 총 추정 비용921.3으로 병렬 시작 비용1000보다도 낮다. workers=4를 지정해도 이 직렬 계획은 바뀌지 않는다. 서비스상담도 전체 추정 비용548.5로 같은 문제다. 반면 이름·회사 접두어는 직렬→worker4로, nested3·메모 서비스는 worker2→4로 바뀌었다. AND6는 GIN 후보 추정57/실제710으로 적은 작업인데도 worker4를 시작하며 절대4.29ms 퇴행했다.', '',
'끝 검색의 heap exact20,461/lossy0에서 4→32MB는 손실 bitmap을 복구할 여지가 없었다. 다른 조건의 상세 lossiness는 위 표와 원시 계획에 남겼다. 이 결과로 work_mem의 전역 상향을 권하지 않는다.', '',
'## 해석 경계와 운영 비용', '',
'관계 `parallel_workers`는 병렬 스캔에 사용할 worker 수에 영향을 주지만 병렬 계획 선택이나 실제 worker 확보를 보장하지 않는다. [PostgreSQL 18 CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html#SQL-CREATETABLE-STORAGE-PARAMETERS).', '',
'병렬 bitmap은 heap 읽기를 나누며 GIN bitmap 생성은 한 프로세스가 수행한다. 관계 옵션으로 후보 수 추정 자체가 정확해지는 것도 아니다. [PostgreSQL 병렬 계획](https://www.postgresql.org/docs/18/parallel-plans.html).', '',
'work_mem은 전체 연결의 총 메모리 한도가 아니라 개별 작업에 적용되고, 여러 작업·연결·worker가 동시에 사용하면 총 사용량이 커진다. 32MB를 전역 설정으로 무조건 권하지 않는다. [PostgreSQL 자원 설정](https://www.postgresql.org/docs/18/runtime-config-resource.html#GUC-WORK-MEM).', '',
'## 검증·산출물', '',
'실행: `node --import tsx bench/followup/r9-impl/load.ts`, 적재 완료 후 `node --import tsx bench/followup/r9-impl/tune.ts`. 측정 락을 획득한 실행만 시간 측정을 수행했다. `npx tsc -p bench/followup/r9-impl/tsconfig.json`, `python bench/followup/r9-impl/report-tuning.py`로 타입·7회 중앙값·복호화 수를 검사한다. [적재](load.json), [DDL](schema.json), [측정과 계획](measure.json), [자기 스키마 정리](cleanup.json).', '',
'동시 서비스 부하, 다른 ID/물리 순서, 다른 키·자료 분포, 다른 서버 설정은 미검증이다. 제품 구현·설정에 자동 적용하지 않았으며 후보의 채택 여부는 아래 실측 해석으로 구분한다.']
(out/'report-ko.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('PASS: 23 jobs, 92 plan groups, rotating7 medians, decryption counts')
