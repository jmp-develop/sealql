"""Verify completed evidence and refresh the report's generated comparison tables."""
import json
from pathlib import Path

out = Path('bench/results/2026-09-29-final-review/r9-impl')
d = json.loads((out / 'active-1000-both.json').read_text(encoding='utf-8'))
assert d['complete'] and d['disjointIds'] and len(d['rows']) == 234
assert d['validation'] == dict(product=30, previous=30, research=30, crossScope=60, saltedKnownRows=18, stampOverlap=0)
assert all(r['transferredLabelMatches'] == 0 for r in d['rows'] if r['scope'] == 'different')
gens = ['pre-r9', 'research', 'product']
fields = ['name', 'phone', 'address', 'memo', 'email', 'company']
names = dict(name='이름', phone='전화', address='주소', memo='메모', email='이메일', company='회사')
def row(field, gen, strategy, n):
    return next(r for r in d['rows'] if r['field'] == field and r['generation'] == gen and r['strategy'] == strategy and r['inserted'] == n and r['scope'] == 'same')
def pct(a, b):
    return f'{100*a/b:.1f}'
lines = ['값 복원율(%), 각 칸은 **R9 이전 / 연구 / 제품** 순서다.', '', '| 입력 전략 | 필드 | N=10 | N=100 | N=1000 |', '|---|---|---:|---:|---:|']
for strategy in ['whole-values', 'packed-pieces']:
    for field in fields:
        cells = [' / '.join(pct(row(field,g,strategy,n)['values'], 1000) for g in gens) for n in [10,100,1000]]
        lines.append('| '+' | '.join([strategy,names[field],*cells])+' |')
lines += ['', '삽입 없는 기준선과 N=1000 조각 라벨 복원율(%). 다른 scope의 값 추정은 아래 기준선과 같으며 모든 조합에서 직접 라벨 전이는 0이다.', '', '| 필드 | 기준선 값 이전/연구/제품 | 무작위 값 | whole 조각 이전/연구/제품 | packed 조각 이전/연구/제품 |', '|---|---:|---:|---:|---:|']
for field in fields:
    base = [row(field,g,'none',0) for g in gens]
    cells = [' / '.join(pct(r['values'],1000) for r in base),pct(base[0]['randomValues'],1000)]
    for strategy in ['whole-values','packed-pieces']:
        rs = [row(field,g,strategy,1000) for g in gens]
        cells.append(' / '.join(pct(r['adjacentOccurrences'],r['adjacentTotal']) for r in rs))
    lines.append('| '+' | '.join([names[field],*cells])+' |')
p = out / 'report-ko.md'
s = p.read_text(encoding='utf-8')
start = '<!-- GENERATED_TABLES -->'
end = '<!-- END_GENERATED_TABLES -->'
if end in s:
    s = s[:s.index(start)] + start + s[s.index(end)+len(end):]
s = s.replace(start,start+'\n\n'+'\n'.join(lines)+'\n\n'+end)
p.write_text(s,encoding='utf-8')
print('PASS: 234 result rows; three actual codecs; zero direct scope transfer; report tables refreshed')
