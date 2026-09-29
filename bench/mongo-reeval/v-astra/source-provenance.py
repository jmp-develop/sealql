"""Record official source revisions; does not copy licensed source into artifacts."""
import datetime
import hashlib
import json
import urllib.request
from pathlib import Path

commit = json.load(urllib.request.urlopen('https://api.github.com/repos/mongodb/libmongocrypt/commits/master'))['sha']
sources = [
    (f'https://raw.githubusercontent.com/mongodb/libmongocrypt/{commit}/src/{name}', f'https://github.com/mongodb/libmongocrypt/blob/{commit}/src/{name}')
    for name in ['mc-text-search-str-encode.c', 'mc-str-encode-string-sets.c', 'mongocrypt-marking.c']
]
sources.append(('https://raw.githubusercontent.com/mongodb/mongo/r8.2.0/src/mongo/crypto/fle_crypto.cpp', 'https://github.com/mongodb/mongo/blob/r8.2.0/src/mongo/crypto/fle_crypto.cpp'))
result = dict(checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), libmongocryptCommit=commit, sources=[])
for raw, url in sources:
    data = urllib.request.urlopen(raw).read()
    result['sources'].append(dict(url=url, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
Path('bench/results/2026-09-30-mongo-reeval/v-astra/source-provenance.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
print(json.dumps(result))
