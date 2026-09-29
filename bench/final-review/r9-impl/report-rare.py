"""Check aggregate math and render rare-query/known-plaintext evidence."""
import json
import math
from pathlib import Path

out=Path('bench/results/2026-09-29-final-review/r9-impl')
d=json.loads((out/'rare.json').read_text(encoding='utf-8'))
assert d['complete'] and len(d['datasets'])==4
assert d['validation']['pieceRows']==200 and d['validation']['product16Rows']==40
def stat(xs):
    a=sorted(xs)
    return {'mean':sum(a)/len(a) if a else 0,'p95':a[math.ceil(len(a)*.95)-1] if a else 0,'max':a[-1] if a else 0}
def triplet(s): return f"{s['mean']:.2f} / {s['p95']:.2f} / {s['max']:.2f}"
def same_stats(actual, expected):
    assert all(math.isclose(actual[k],expected[k],rel_tol=1e-12,abs_tol=1e-12) for k in expected)
total_queries=0
for ds in d['datasets']:
    assert ds['rows']==100000 and [v['bits'] for v in ds['variants']]==[16,14,12]
    base=ds['variants'][0]['search']
    for v in ds['variants']:
        assert [(q['term'],q['matches']) for q in v['search']]==[(q['term'],q['matches']) for q in base]
        for q in v['search']:
            assert 1<=q['matches']<=10 and q['candidates']>=q['matches']
        for s in v['summary']:
            qs=[q for q in v['search'] if q['width']==s['width']]
            same_stats(s['candidates'],stat([q['candidates'] for q in qs]))
            same_stats(s['factor'],stat([q['factor'] for q in qs]))
        for k in v['known']:
            assert k['unknownRows']==100000-k['knownRows']
            assert math.isclose(k['mostlyPct'],100*k['mostly']/k['unknownRows'])
        total_queries+=len(v['search'])
assert d['validation']['truthQueries']==total_queries
lines=['# 드문 검색어와 알려진 원문: 16·14·12비트', '',
'**결론: 16비트 유지, 12·14비트 미채택.** 공개 리뷰의 드문 2글자에서 평균 후보가 14비트 4.92배, 12비트 22.58배로 증가했다. 12비트는 최대 후보도 2,034→15,920행으로 증가해 “보안 개선 + 다른 것 저하 없음”을 만족하지 않는다. 14비트의 선택 삽입 이득은 전화 95.9→89.5%, 주소 변화 없음으로 제한적이다. 아래 후보 수 증가는 실제 관측한 저하이며 SQL 시간 배수는 아니다. 이 시험은 특정 공격의 누출 하한을 재계산한 것이므로 모든 공격에 대한 보안 개선을 증명하지 않는다. 제품·DB·결정 기록은 변경하지 않았다.', '',
'## 토큰 비트는 나중에도 바꿀 수 있다', '',
'**확실: 마지막 기회 항목이 아니다.** 후보 토큰은 검색 표에만 저장되며, 기존 본문 암호문을 가진 채 나중에 다시 생성할 수 있다. [reindex 구현](../../../../src/adapters/drizzle/v0.45/native-runtime.ts#L302)은 부모 행을 잠가 읽고 `open(rows)`로 인증 복호화한 뒤 `searchPieces`·`searchTokens`와 증거를 다시 계산하여 검색 표만 삽입·수정·삭제한다. 부모 암호문을 다시 쓰는 단계는 없다. [본문 암호화의 키 파생과 AAD](../../../../src/core/field-cipher.ts#L46)에도 검색 토큰 비트는 들어가지 않는다.', '',
'따라서 향후 비트 변경 구현과 전체 `reindex`로 본문 재암호화 없이 바꿀 수 있다. 현재 substring 공개 API는 16비트 고정이므로 설정만으로 14/12를 쓸 수 있다는 뜻은 아니다. 앱 키를 사용한 전체 인증 복호화·검색 표 재작성 비용과 쓰기/질의 형식 전환은 필요하며, 부분 재색인 상태로 새 질의를 사용하면 누락할 수 있다. 이번에는 코드 경로만 확인했고 DB 변경·마이그레이션 실행은 하지 않았다.', '',
'## 재현 조건', '',
'- 공개 NSMC 리뷰 파일에서 원래 길이가 2 이상인 비어 있지 않은 첫 100,000행을 사용했다. fixture는 기존 100,000행의 메모·주소·이름을 각각 사용했다. 공개 리뷰는 메모리에서만 처리하고 fixture는 일회용 DB에서 읽기만 했다.',
'- 검색어는 제품 정규화 후 연속 2·3·4글자 중 Unicode 문자(Letter)만으로 이루어진 조각이다. 완성된 사전 단어만 추출하거나 형태소 분석한 표본은 아니다. fixture의 문자형 임의 접미사도 포함되므로 자연어 판단에는 공개 리뷰 표를 우선한다.',
'- 빈도는 등장 횟수가 아닌 등장 **행 수**다. 빈도 1~10인 서로 다른 검색어에서 길이별 균등 reservoir 표집(seed 20260929+길이)으로 최대 200개를 뽑았다. 같은 검색어·같은 행을 세 폭에 사용했다. 부족한 조합은 아래 표에 명시했다.',
'- 제품의 인접 2글자+값 시작/끝+skip 조각을 사용했다. word 경계 조각은 없다. 쓰기 조각과 질의 contains 조각은 제품 함수에 맞췄다. 가상 폭은 직전 비트 실험과 같이 descriptor의 폭과 HMAC 절단을 함께 바꾼다. 한 키·한 scope 결과이며 폭별 파생 키가 다르다.',
'- 알려진 원문 공격은 결정 004와 같은 행집합 출현 서명 대응이다. seed99 Fisher–Yates의 중첩 1%/5% 원문만 사용하고, 대응 평문 조각이 하나인 경우만 추정한다. 정답/키를 추정 알고리즘에 사용하지 않는다.',
'- 80%+ 지표는 **모르는 행의 저장 전 고유 조각 집합 전체(인접·시작·끝·skip)** 중 정확히 라벨링된 비율이 80% 이상인 행의 비율이다. 행 내 중복은 제거한다. 전체 조각/인접 해독률의 등장 분모는 알려진 행을 포함하는 전체 10만 행으로, 과거 하네스의 지표 정의와 같다.',
'- 결정 004 당시 비트 하네스는 옛 구성/프로필의 16비트 descriptor를 고정하고 절단만 바꿨다. 이번 표는 현재 구성과 새 후보 descriptor이므로 옛 수치의 재현값이 아니라 **같은 지표의 현재 제품 재계산**이다.', '',
'## 검색어 수', '', '| 데이터 | 길이 | DF1~10 어휘 수 | 표집 | 부족 |', '|---|---:|---:|---:|---:|']
for ds in d['datasets']:
    for s in ds['selection']: lines.append(f"| {ds['name']} | {s['width']} | {s['eligible']:,} | {s['sampled']} | {s['shortage']} |")
lines += ['', '## 후보 행 수와 정답 대비 배수', '',
'각 3개 숫자는 **평균 / p95 / 최대**다. 정답 대비 배수는 검색어별 후보/정답의 분포이며, 평균 후보를 평균 정답으로 나눈 값과 다르다. 16 대비 평균은 동일 검색어 집합의 후보 합 비율이다.', '',
'| 데이터 | 길이 | 폭 | 후보 행 평균/p95/최대 | 후보÷정답 평균/p95/최대 | 후보 평균/16비트 |', '|---|---:|---:|---:|---:|---:|']
for ds in d['datasets']:
    for w in [2,3,4]:
        for v in ds['variants']:
            s=next(s for s in v['summary'] if s['width']==w)
            ratio='표본 없음' if s['ratioOfMeans'] is None else f"{s['ratioOfMeans']:.3f}"
            candidate_text=triplet(s['candidates']) if s['sampled'] else '표본 없음'
            factor_text=triplet(s['factor']) if s['sampled'] else '표본 없음'
            lines.append(f"| {ds['name']} | {w} | {v['bits']} | {candidate_text} | {factor_text} | {ratio} |")
words=json.loads((out/'rare-words.json').read_text(encoding='utf-8'))
assert words['complete'] and len(words['datasets'])==4
for a,b in zip(d['datasets'],words['datasets']):
    assert a['digest']==b['digest']
    for va,vb in zip(a['variants'],b['variants']):
        assert va['known']==vb['known']
        for s in vb['summary']:
            qs=[q for q in vb['search'] if q['width']==s['width']]
            same_stats(s['candidates'],stat([q['candidates'] for q in qs]))
            same_stats(s['factor'],stat([q['factor'] for q in qs]))
lines += ['', '## 원문 단어로 제한한 추가 대조', '',
'연속 조각이 실제 단어가 아닐 가능성을 따로 확인했다. 원문에서 공백·숫자·구두점으로 구분한 Unicode 문자 연속 구간 전체가 2/3/4글자인 경우만 어휘에 넣고, 정규화 contains 빈도 1~10인 것에서 다시 길이별 200개를 뽑았다. 사전/형태소 분석은 아니지만 원문에 독립된 문자 구간으로 등장한 단어 표본이다. `--words` 옵션으로 재현하며 [별도 원시 결과](rare-words.json)에 fixture까지 기록했다. 알려진 원문 공격은 같은 행·구성이므로 두 실행의 결과가 완전히 같음을 확인했다.', '',
'공개 리뷰에서 단어로 제한해도 2글자 후보 평균은 14비트 3.32배, 12비트 14.98배로 증가했다. 미채택 결론은 같다.', '',
'| 길이 | 폭 | 후보 평균/p95/최대 | 후보÷정답 평균/p95/최대 | 후보 평균/16비트 |', '|---:|---:|---:|---:|---:|']
for w in [2,3,4]:
    for v in words['datasets'][0]['variants']:
        s=next(s for s in v['summary'] if s['width']==w)
        lines.append(f"| {w} | {v['bits']} | {triplet(s['candidates'])} | {triplet(s['factor'])} | {s['ratioOfMeans']:.3f} |")
lines += ['', '## 결정 004와 같은 알려진 원문 지표', '', '| 데이터 | 폭 | 알려진 원문 | 80%+ 해독 행/모르는 행 | 비율(%) | 인접 조각 해독(%) | 전체 조각 해독(%) |', '|---|---:|---:|---:|---:|---:|---:|']
for ds in d['datasets']:
    for v in ds['variants']:
        for k in v['known']:
            lines.append(f"| {ds['name']} | {v['bits']} | {k['knownPct']}% | {k['mostly']}/{k['unknownRows']} | {k['mostlyPct']:.4f} | {k['adjacentPct']:.2f} | {k['allPiecePct']:.2f} |")
lines += ['', '원문 5% 결과가 1%보다 작을 수도 있다. 아는 행이 늘면 충돌 토큰의 출현 집합이 더 많은 조각의 합집합으로 드러나 고유 서명 대응을 잃기 때문이다. 공격자가 정보를 더 알수록 실제로 더 안전해진다는 뜻이 아니다. 더 강한 충돌 해소·일관성 공격을 실행하지 않은 하한이다.', '',
'## 선택 삽입 공격 요약', '', '| 폭 | 전화 whole/packed 값 복원 | 주소 whole/packed 값 복원 |', '|---:|---:|---:|']
b=json.loads((out/'bits.json').read_text(encoding='utf-8'))
for bits in [16,14,12]:
    cells=[]
    for field in ['phone','address']:
        cells.append(' / '.join(f"{next(r for r in b['attack'] if r['bits']==bits and r['field']==field and r['strategy']==strategy and r['n']==1000)['percent']:.1f}%" for strategy in ['whole-values','packed-pieces']))
    lines.append(f"| {bits} | {' | '.join(cells)} |")
lines += ['', '같은 scope, 알려진 입력 1,000행, 별도 피해 1,000행이며 [직전 결과](bits-report-ko.md)를 요약했다. 주소는 whole 전략에서 비트 축소 후에도 81.9%였다. 안정된 후보 토큰의 대응 원인은 유지된다.', '',
'## 공개 리뷰의 최대 후보 사례', '', '| 길이 | 폭 | 검색어 | 정답 | 후보 | 후보/정답 | 16비트 후보 |', '|---:|---:|---|---:|---:|---:|---:|']
ds=d['datasets'][0]
base={q['term']:q for q in ds['variants'][0]['search']}
for w in [2,3,4]:
    for v in ds['variants']:
        qs=[q for q in v['search'] if q['width']==w]
        if qs:
            q=max(qs,key=lambda q:q['candidates'])
            lines.append(f"| {w} | {v['bits']} | {q['term']} | {q['matches']} | {q['candidates']} | {q['factor']:.2f} | {base[q['term']]['candidates']} |")
lines += ['', '## 검증과 미검증', '',
f"실행: `node --expose-gc --max-old-space-size=4096 --import tsx bench/final-review/r9-impl/rare.ts`; 완료 출력 `COMPLETE rare`. 빠른 조각 생성과 제품 `searchPieces`를 200행, 16비트 토큰과 제품 `searchTokens`를 40행 대조했다. {total_queries:,}개 검색어/폭 조합의 평문 정답을 독립 전체 스캔으로 대조하고 누락 0을 확인했다. `npx tsc -p bench/final-review/r9-impl/tsconfig.json`과 `python bench/final-review/r9-impl/report-rare.py`로 타입·원시 결과 집계를 검증한다. [원시 결과](rare.json).", '',
'SQL 실행 시간, GIN 비용·통계·병렬 계획, 여러 키·여러 추첨, 0건 검색어, 다중 scope, 다른 언어 말뭉치, 더 강한 충돌 해소 공격은 미검증이다. 후보 집합은 조각 구성 자체의 오탐과 비트 충돌을 함께 포함한다. 표의 차이는 이 데이터·키·질의 표본에서 측정한 결과이며 운영 성능이나 보안 인증이 아니다.']
(out/'rare-report-ko.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print(f"PASS: four datasets; {total_queries} substring + {words['validation']['truthQueries']} word query variants; 24 identical known-plaintext metrics; aggregate math")
