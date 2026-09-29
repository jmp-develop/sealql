"""Recalculate historical C-port evidence, without DB access."""
import hashlib
import json
from pathlib import Path

src = Path('bench/results/2026-09-28-unified')
out = Path('bench/results/2026-09-30-mongo-reeval/v-astra')
out.mkdir(parents=True, exist_ok=True)
def read(name):
    return json.loads((src / ('m2-fable-' + name + '.json')).read_text())
counts, lists, sizes = read('measure'), read('lists'), read('sizes')['unified']
plain = [x for x in sizes if x['relname'].startswith(('customers_plain', 'tickets_plain'))]
c = [x for x in sizes if x['relname'].startswith(('customers_ct', 'tickets_ct')) or x['relname'] in ('esc', 'esc_pkey')]
ps, cs = sum(int(x['bytes']) for x in plain), sum(int(x['bytes']) for x in c)
def thin(row):
    return dict(label=row['label'], truth=row['truth'], totalMs=row['medians']['C'], sqlMs=row['dbMedians']['C'], meta=row['meta']['C'], failed=row['failed'])
data = dict(complete=True, mode='read-only historical artifact recomputation; no new latency measurement',
            sources={str(p).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(src.glob('m2-fable-*.json'))},
            plainBytes=ps, cBytes=cs, ratio=cs/ps, cComponents=c,
            counts=[thin(x) for x in counts], lists=[thin(x) for x in lists], load=read('load'), write=read('write'))
assert len(counts) == 24
assert len(lists) == 18
assert 89 < cs/ps < 91
assert all(x['meta']['decrypts']==0 for x in data['counts'] if x['label'].split(' | ')[0] in ('count exact_common','count and2','count and4','count and6','count sub_common_memo'))
(out/'historical-performance.json').write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps(dict(complete=True,counts=len(counts),lists=len(lists),plainBytes=ps,cBytes=cs,ratio=cs/ps)))
