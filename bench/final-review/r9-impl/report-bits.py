"""Render the measured bit-width tradeoff, without equating candidates to SQL latency."""
import json
from pathlib import Path

out = Path('bench/results/2026-09-29-final-review/r9-impl')
d = json.loads((out/'bits.json').read_text(encoding='utf-8'))
assert d['complete'] and len(d['attack']) == 36 and len(d['candidates']) == 55
def attack(field, strategy, n, bits):
    return next(r for r in d['attack'] if (r['field'],r['strategy'],r['n'],r['bits']) == (field,strategy,n,bits))
lines = ['# 후보 토큰 16·14·12비트: 선택 삽입 공격과 후보 수', '',
'**확실:** 같은 공격에서 비트를 줄이면 전화 복원이 감소했지만, 주소는 알려진 완전한 값을 삽입하는 전략에서 81.9%로 유지됐다. 비트 축소는 안정된 후보 토큰의 선택 평문 대응이라는 원인을 제거하지 않는다. **모름:** 충돌을 함께 추론하는 더 강한 공격에서도 이 감소가 유지되는지는 검증하지 않았다.', '',
'## 동일 조건', '',
'기존 fixture 100,000행 읽기만, 참조 10,000행·서로 다른 피해 1,000행, 두 삽입 전략과 N=10/100/1000을 그대로 사용했다. 제품 코드와 DB 저장물은 바꾸지 않았다. substring 토큰만 16/14/12비트로 가정하고 도메인 descriptor의 비트 인자와 HMAC 절단을 함께 바꿨다. exact는 회사 2비트·그 밖 16비트로 유지했다. 제품의 공개 API는 14/12비트 substring을 지원하지 않으며 이 파일은 후보 저장 형식의 메모리 실험이다.', '',
'도메인에 비트 수가 들어가므로 각 폭에서 키 파생 결과도 달라진다. 동일한 한 키·고정 데이터 비교이며, 단순히 같은 16비트 토큰의 하위 비트를 지운 대조 실험이나 여러 키 평균은 아니다. 새 저장 형식을 실제 채택하면 기존 후보 토큰과 질의 토큰을 함께 다시 생성해야 한다.', '',
'## 값 복원율(%)', '', '| 필드 | 삽입 전략 | N | 16비트 | 14비트 | 12비트 |', '|---|---|---:|---:|---:|---:|']
for field in ['phone','address']:
    for strategy in ['whole-values','packed-pieces']:
        for n in [10,100,1000]:
            values = [f"{attack(field,strategy,n,b)['percent']:.1f}" for b in [16,14,12]]
            lines.append('| '+' | '.join([field,strategy,str(n),*values])+' |')
lines += ['', '복원은 정규화한 전체 값의 정확 일치다. 16비트 결과는 직전 세 방식 비교의 제품 결과와 일치함을 검사했다. 전화 그래프 탐색 상한(2,000상태)은 그대로 유지했다. 주소 packed 전략의 비단조 변화는 고유 출현 서명과 사전의 엄격한 대응이 충돌에 민감하기 때문이며, 공격자는 이전에 얻은 결과를 버릴 필요가 없다. 이 수치를 최강 공격의 상한으로 읽지 않는다.', '',
'## 55개 조건 후보 행 수', '',
'[기존 55조건](../../2026-09-29-final-return/cases.json) 전부를 같은 100,000행에 적용했다. LIKE 3개는 동등한 단일 literal 정규형으로 바꾸고, exact 토큰 일치·substring 토큰 포함·AND/OR Boolean 식으로 **위치 판정 전 후보 집합**을 계산했다. 각 leaf의 평문 일치가 후보에서 빠지지 않음을 전체 행에서 검사했다. 목록 LIMIT·quick 경로·병렬 계획·TOAST·함수 비용은 포함하지 않는다. 후보 수 비율은 SQL 시간 배수가 아니다.', '',
'| 폭 | 조건당 평균 후보 | 최대 후보 | 평균/16비트 | 최대 후보/16비트 최대 | 가장 큰 개별 조건 배수(분모>0) |', '|---:|---:|---:|---:|---:|---:|']
base = d['summary'][0]
for s in d['summary']:
    lines.append(f"| {s['bits']} | {s['mean']:.2f} | {s['max']:,} | {s['meanRatio']:.6f} | {s['max']/base['max']:.4f} | {s['maxCaseRatio']:.4f} |")
for bits in [14,12]:
    worst=max(d['candidates'],key=lambda c: c['ratios'][str(bits)] or 0)
    lines.append(f"\n{bits}비트의 최대 개별 배수 조건은 `{worst['name']}`: {worst['counts']['16']} → {worst['counts'][str(bits)]}행이다.")
for s in d['summary']:
    lines.append(f"\n{s['bits']}비트: 16비트에서 후보 0이었던 조건이 양수로 바뀐 조건: {', '.join(s['zeroToPositive']) or '없음'}.")
lines += ['', '## 판단과 한계', '',
'**확실:** 12비트도 같은 scope의 전화 절반 이상과 주소 81.9%를 이 공격이 복원했다. 따라서 이번 결과는 비트 축소만으로 선택 삽입 공격을 막는다는 근거가 아니다. **추정:** 고유 대응 라벨을 버리는 현재 공격 대신 충돌을 함께 푸는 공격은 더 복원할 수 있다. 이를 구현하거나 측정하지 않았다. 비트 축소를 보안 해결책으로 확정하지 않으며 실제 SQL 성능·다른 키 분포·더 강한 공격 검증이 남는다.', '',
'실행: `node --import tsx bench/final-review/r9-impl/bits.ts`. 실제 완료 출력: `COMPLETE bits`. 검증: `npx tsc -p bench/final-review/r9-impl/tsconfig.json`, `node --import tsx bench/final-review/r9-impl/verify-bits.ts`, `python bench/final-review/r9-impl/report-bits.py`. 독립 WebCrypto 경로에서 가상 폭 토큰을 대조하고, 실제 제품 exact 토큰 18개·16비트 공격 회귀·집계 산술을 검사했다. [원시 결과](bits.json)와 [공격 정의](report-ko.md)를 함께 읽는다.', '',
'## 조건별 후보 수', '', '| 조건 | 16비트 | 14비트 | 12비트 | 14/16 | 12/16 |', '|---|---:|---:|---:|---:|---:|']
for c in d['candidates']:
    ratio=lambda b: '분모 0' if c['ratios'][str(b)] is None else f"{c['ratios'][str(b)]:.4f}"
    lines.append('| '+' | '.join([c['name'],*[str(c['counts'][str(b)]) for b in [16,14,12]],ratio(14),ratio(12)])+' |')
(out/'bits-report-ko.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('PASS: bit-width report rendered from 36 attacks and 55 complete candidate comparisons')
