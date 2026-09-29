import json
import math
from pathlib import Path
out=Path('bench/results/2026-09-29-followup/token-bits')
d=json.loads((out/'phone.json').read_text(encoding='utf-8'))
assert d['complete'] and d['rows']==100000 and d['validation']['priorAttackMatches']==12 and d['validation']['actual16Rows']==5
base={q['term']:q for q in d['search'] if q['bits']==16}
for q in d['search']:
    assert q['candidates']>=q['matches'] and math.isclose(q['factor'],q['candidates']/q['matches'])
    assert q['matches']==base[q['term']]['matches']
lines=['# 전화 칸만 12비트로 줄이는 후보', '',
'**결론:** 이 전화 fixture에서는 공개 리뷰의 드문 2글자처럼 평균 후보가 22.6배 늘지는 않았다. 그러나 개별 2글자는 3.54배, 드문 4글자는 2.93배 늘어 “보안 개선 + 저하 없음”은 입증하지 못했다. 선택 삽입 공격의 전화 복원은 95.9→51.5%로 줄었지만 안정된 후보 토큰을 이용하는 공격 원인은 남는다. 칸별 옵션을 제품에 추가하지 않았다.', '',
'## 조건', '',
'기존 fixture 전화 100,000행을 읽기만 하고 메모리에서 substring 후보 16/12비트를 비교했다. 키·scope·정규화·도메인 처리·공격 알고리즘은 [직전 실험](../../2026-09-29-final-review/r9-impl/bits-report-ko.md)과 같다. 전화 외 칸의 substring 16비트와 모든 exact 설정은 변경 대상이 아니다. 제품의 기본 legacy 정규화는 공백을 제거하지만 전화의 하이픈을 유지하므로, 숫자와 하이픈이 있는 실제 부분 문자열을 그대로 사용했다.', '',
'드문 검색어는 등장 행 수 1~10이며, 2/3/4글자마다 최대 200개를 seed 20260929+길이로 뽑았다. 드문 검색어가 없을 때에는 빈도가 낮은 실제 검색어 최대 200개를 별도 대조군으로 사용했다. 이를 드문 검색어 측정으로 바꾸어 부르지 않는다.', '',
'| 길이 | 서로 다른 검색어 | 최소 행 빈도 | DF1~10 검색어/표집 | 추가 대조 |', '|---:|---:|---:|---:|---|']
for s in d['selection']:
    lines.append(f"| {s['width']} | {s['distinct']:,} | {s['minFrequency']:,} | {s['rareAvailable']}/{s['rareSampled']} | {'최소 빈도 '+str(min(200,s['distinct']))+'개' if not s['rareSampled'] else '없음'} |")
lines += ['', '## 후보 수', '',
'후보 수의 세 숫자는 평균 / p95 / 최대다. 평균/16은 후보 합의 비율이고 개별 최대 배수와 구분한다. 실제 SQL 시간은 측정하지 않았다.', '',
'| 길이 | 폭 | 후보 평균/p95/최대 | 정답 대비 평균 배수 | 평균 후보/16비트 | 개별 최대/16비트 |', '|---:|---:|---:|---:|---:|---:|']
for s in sorted(d['summary'],key=lambda s:(s['width'],-s['bits'])):
    c=s['candidates'];lines.append(f"| {s['width']} | {s['bits']} | {c['mean']:.2f} / {c['p95']} / {c['max']} | {s['factor']['mean']:.3f} | {s['ratioOfMeans']:.4f} | {s['relative16']['max']:.4f} |")
lines += ['', '2글자 `47`은 정답 7,020행, 후보 7,020→24,875행으로 3.54배 증가했다. 드문 4글자 `6266`은 정답 10행, 후보 14→41행이다. 평균 증가는 작아도 특정 검색어의 증가를 숨기지 않는다.', '',
'## 같은 선택 삽입 공격 재실행', '', '| 삽입 전략 | 알려진 입력 N | 16비트 전체 값 복원 | 12비트 전체 값 복원 |', '|---|---:|---:|---:|']
for strategy in ['whole-values','packed-pieces']:
    for n in [10,100,1000]:
        rs=[next(r for r in d['attack'] if r['bits']==b and r['strategy']==strategy and r['n']==n) for b in [16,12]]
        lines.append(f"| {strategy} | {n} | {rs[0]['pct']:.1f}% | {rs[1]['pct']:.1f}% |")
lines += ['', '참조 10,000행과 ID가 겹치지 않는 피해 1,000행, 같은 scope, 질의 키 없음이다. 모든 12개 복원 결과가 앞선 비트 실험과 정확히 같음을 단언했다. 충돌을 함께 푸는 더 강한 공격은 미검증이므로 감소를 보안 보장으로 표현하지 않는다.', '',
'## 검증·한계', '',
'실행: `node --import tsx bench/followup/r9-impl/phone-bits.ts`, 실제 출력 `COMPLETE phone bits`. `npx tsc -p bench/followup/r9-impl/tsconfig.json`, `python bench/followup/r9-impl/report-phone.py`로 타입·산술을 검사한다. 16비트 실제 제품 토큰 5행 대조, 과거 공격 12개 일치, 모든 검색어의 전체 평문 스캔과 후보 누락 0을 확인했다. [원시 결과](phone.json).', '',
'2/3글자의 DF1~10 검색어가 없는 이 fixture로 다른 국가·전화 형식·더 작은 scope의 희귀 검색을 보장할 수 없다. SQL 지연·동시 부하·여러 키·다른 형식 칸은 측정하지 않았다. 로컬 합성 fixture 결과이며 운영 보장·보안 인증이 아니다.']
(out/'report-ko.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('PASS: phone width evidence, 12 attack regressions and candidate arithmetic')
