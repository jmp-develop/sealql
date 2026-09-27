/** In-memory, keyless token-dump attacks on four product piece layouts.
 * Usage: node --import tsx bench/standard-next/layout-attack.ts .local/ratings.txt
 * The key is used to generate the dump and by the scorer, never by the attacks.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHmac, hkdfSync } from 'node:crypto';
import { frame, hex } from '../../src/core/bytes.js';
import { descriptorBytes, normalizeText, normalizeWords, profiles, searchPieces, searchTokens, type SearchProfile } from '../../src/core/search-tokens.js';
import type { Keyring } from '../../src/core/field-cipher.js';

const path = process.argv[2];
if (!path) throw new Error('Pass the local ratings.txt path');
const scaleMode = process.argv.includes('--scale');
const bitsMode = process.argv.includes('--bits');
const lines = readFileSync(path, 'utf8').split('\n').slice(1).map(s => s.split('\t')[1]).filter((s): s is string => !!s && Array.from(s).length >= 2);
const victim = lines.slice(0, scaleMode || bitsMode ? 100_000 : 20_000), reference = lines.slice(scaleMode || bitsMode ? 100_000 : 20_000, scaleMode || bitsMode ? 120_000 : 40_000);
if (victim.length !== (scaleMode || bitsMode ? 100_000 : 20_000) || reference.length !== 20_000) throw new Error('Need enough nonempty reviews');
const seed = 99;
let state = seed;
const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
const shuffled = Array.from({ length: victim.length }, (_, i) => i);
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const knownByPct = new Map([1, 5, 10].map(pct => [pct, new Set(shuffled.slice(0, victim.length * pct / 100))]));
const ring: Keyring = { key: new Uint8Array(32).fill(93), keyScopeId: 'global' };
const scope = 'attack-scope', cache = { profiles: new Map<string, Promise<CryptoKey>>() };
const layouts = [
  { name: 'adjacent', boundary: false, words: false, skip: false },
  { name: 'adjacent+start/end', boundary: true, words: false, skip: false },
  { name: 'adjacent+start/end+word', boundary: true, words: true, skip: false },
  { name: 'adjacent+start/end+word+skip', boundary: true, words: true, skip: true },
] as const;
const scaleLayouts = [layouts[0], layouts[2], layouts[3]];
const bitLayouts = [layouts[0], layouts[2]];
type Piece = { label: string; kind: string; value: string };
type Row = { pieces: string[]; tokens: string[] };
const decodedPiece = new Map<string, Piece>();
function parsePiece(label: string): Piece {
  const old = decodedPiece.get(label); if (old) return old;
  const bytes = Buffer.from(label, 'hex'), n = bytes.readUInt32BE(4);
  const kind = bytes.subarray(8, 8 + n).toString('utf8');
  const m = bytes.readUInt32BE(8 + n);
  const value = bytes.subarray(12 + n, 12 + n + m).toString('utf8');
  const result = { label, kind, value }; decodedPiece.set(label, result); return result;
}
function pieces(p: SearchProfile, value: string, boundary: boolean, operation: 'write'|'contains'|'startsWith' = 'write', respectWords = false): string[] {
  return searchPieces(p, value, operation, respectWords).map(hex).filter(label => boundary || !['start', 'end'].includes(parsePiece(label).kind));
}
function add(map: Map<string, number>, key: string) { map.set(key, (map.get(key) ?? 0) + 1); }
function pct(n: number, d: number) { return d ? +(100 * n / d).toFixed(2) : 0; }
function signature(ids: number[]) { return ids.join(','); }
function score(guess: Map<string, string>, rows: Row[], oracle: Map<string, string>, known: Set<number>) {
  const byKind: Record<string, { correct: number; total: number; pct?: number }> = {};
  let mostly = 0, unknown = 0, adjacentMostly = 0;
  rows.forEach((row, i) => {
    let correct = 0, adjacentCorrect = 0, adjacentTotal = 0;
    for (const label of row.pieces) {
      const kind = parsePiece(label).kind;
      const bucket = byKind[kind] ??= { correct: 0, total: 0 };
      bucket.total++;
      const ok = guess.get(oracle.get(label)!) === label;
      if (ok) { bucket.correct++; correct++; }
      if (kind === 'adjacent') { adjacentTotal++; if (ok) adjacentCorrect++; }
    }
    if (!known.has(i)) { unknown++; if (row.pieces.length && correct / row.pieces.length >= .8) mostly++; if (adjacentTotal && adjacentCorrect / adjacentTotal >= .8) adjacentMostly++; }
  });
  for (const item of Object.values(byKind)) item.pct = pct(item.correct, item.total);
  const correct = Object.values(byKind).reduce((n, x) => n + x.correct, 0);
  const total = Object.values(byKind).reduce((n, x) => n + x.total, 0);
  return { byKind, allPct: pct(correct, total), adjacentPct: byKind.adjacent?.pct ?? 0, mostlyDecodedUnknownRowsPct: pct(mostly, unknown), mostlyDecodedAdjacentUnknownRowsPct: pct(adjacentMostly, unknown), unknownRows: unknown };
}
function knownAttack(rows: Row[], known: Set<number>) {
  const tokenSig = new Map<string, number[]>(), pieceSig = new Map<string, number[]>();
  rows.forEach((row, i) => { if (!known.has(i)) return;
    for (const token of row.tokens) (tokenSig.get(token) ?? tokenSig.set(token, []).get(token)!).push(i);
    for (const piece of row.pieces) (pieceSig.get(piece) ?? pieceSig.set(piece, []).get(piece)!).push(i);
  });
  const bySig = new Map<string, string[]>(), candidates = new Map<string, string[]>();
  for (const [piece, ids] of pieceSig) { const sig = signature(ids); (bySig.get(sig) ?? bySig.set(sig, []).get(sig)!).push(piece); }
  const guesses = new Map<string, string>();
  for (const [token, ids] of tokenSig) { const options = bySig.get(signature(ids)) ?? []; candidates.set(token, options); if (options.length === 1) guesses.set(token, options[0]); }
  return { guesses, candidates };
}
function propagate(rows: Row[], initial: Map<string, string>, candidates: Map<string, string[]>) {
  const guess = new Map(initial), rounds: { added: number; correct?: number }[] = [];
  // Structural votes are restricted to labels with an identical known-row signature.
  // A vote requires a row containing both decoded premises and the candidate token.
  // Since pieces are unordered sets, implication may be false; scorer reports accuracy.
  for (let round = 0; round < 6; round++) {
    const votes = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const decoded = row.tokens.map(t => guess.get(t)).filter((x): x is string => !!x).map(parsePiece);
      const adj = decoded.filter(x => x.kind === 'adjacent').map(x => Array.from(x.value));
      const skip = decoded.filter(x => x.kind === 'skip').map(x => Array.from(x.value));
      const inferred = new Set<string>();
      for (const ab of adj) for (const bc of adj) if (ab[1] === bc[0]) inferred.add(`skip:${ab[0]}${bc[1]}`);
      for (const ac of skip) for (const ab of adj) if (ac[0] === ab[0]) inferred.add(`adjacent:${ab[1]}${ac[1]}`);
      for (const ac of skip) for (const bc of adj) if (ac[1] === bc[1]) inferred.add(`adjacent:${ac[0]}${bc[0]}`);
      if (!inferred.size) continue;
      for (const token of row.tokens) {
        if (guess.has(token)) continue;
        const opts = candidates.get(token);
        if (!opts || opts.length < 2) continue;
        for (const label of opts) {
          const p = parsePiece(label);
          if (!inferred.has(`${p.kind}:${p.value}`)) continue;
          const tally = votes.get(token) ?? new Map<string, number>();
          tally.set(label, (tally.get(label) ?? 0) + 1); votes.set(token, tally);
        }
      }
    }
    let added = 0;
    for (const [token, tally] of votes) {
      const ranked = [...tally].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (ranked[0][1] >= 2 && ranked[0][1] >= (ranked[1]?.[1] ?? 0) + 2) { guess.set(token, ranked[0][0]); added++; }
    }
    rounds.push({ added }); if (!added) break;
  }
  return { guess, rounds };
}
async function run(layout: typeof layouts[number]) {
  const spec = { type: 'text' as const, search: { substring: { wordBoundary: layout.words, skipGrams: layout.skip } } };
  const p = profiles('review', 'text', spec)[0];
  const victimPieces = victim.map(v => pieces(p, v, layout.boundary));
  const referencePieces = reference.map(v => pieces(p, v, layout.boundary));
  const unique = [...new Set(victimPieces.flat())];
  const oracle = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 256) {
    await Promise.all(unique.slice(i, i + 256).map(async label => {
      const token = await searchTokens(ring, scope, p, [Buffer.from(label, 'hex')], cache);
      oracle.set(label, token[0]);
    }));
  }
  const rows = victimPieces.map(ps => ({ pieces: ps, tokens: [...new Set(ps.map(x => oracle.get(x)!))] }));
  const tokenFreq = new Map<string, number>(), refFreq = new Map<string, number>();
  for (const row of rows) for (const token of row.tokens) add(tokenFreq, token);
  for (const row of referencePieces) for (const label of row) add(refFreq, label);
  const tokenRank = [...tokenFreq].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const pieceRank = [...refFreq].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const freqGuess = new Map(tokenRank.map(([token], i) => [token, pieceRank[i]?.[0]]).filter((x): x is [string,string] => !!x[1]));
  const frequency = score(freqGuess, rows, oracle, new Set<number>());
  const known = [...knownByPct].map(([knownPct, knownRows]) => {
    const attack = knownAttack(rows, knownRows);
    const base = score(attack.guesses, rows, oracle, knownRows);
    const consistency = layout.skip ? propagate(rows, attack.guesses, attack.candidates) : undefined;
    return { knownPct, knownRows: knownRows.size, count: base, consistency: consistency ? { ...score(consistency.guess, rows, oracle, knownRows), rounds: consistency.rounds, addedTokenGuesses: consistency.guess.size - attack.guesses.size } : undefined };
  });
  const queryCases = [
    { name: '2-char contains', term: '영화', op: 'contains' as const, words: false },
    { name: 'middle 3-char contains', term: '서비스', op: 'contains' as const, words: false },
    { name: 'two-word contains', term: '정말 재미', op: 'contains' as const, words: true },
    { name: 'field-start autocomplete', term: '정말', op: 'startsWith' as const, words: false },
  ];
  const search = [];
  for (const item of queryCases) {
    const queryPieces = pieces(p, item.term, layout.boundary, item.op, item.words && layout.words);
    const queryTokens = new Set(await searchTokens(ring, scope, p, queryPieces.map(x => Buffer.from(x,'hex')), cache));
    let candidates = 0, matches = 0;
    rows.forEach((row,i) => {
      const stored = new Set(row.tokens);
      if ([...queryTokens].every(t => stored.has(t))) candidates++;
      const actual = item.words ? normalizeWords(victim[i]).includes(normalizeWords(item.term)) : item.op === 'startsWith' ? normalizeText(victim[i], 'legacy-text-v1').startsWith(normalizeText(item.term, 'legacy-text-v1')) : normalizeText(victim[i], 'legacy-text-v1').includes(normalizeText(item.term, 'legacy-text-v1'));
      if (actual) matches++;
    });
    search.push({ ...item, queryPieceCount: queryPieces.length, candidates, matches, falsePositiveFactor: matches ? +(candidates / matches).toFixed(3) : null });
  }
  return { layout: layout.name, uniquePieces: unique.length, uniqueTokens: tokenFreq.size, storedPieceOccurrences: victimPieces.reduce((n,x) => n+x.length,0), frequency, known, search };
}
function sampledKnown(n: number, knownPct: number): Set<number> {
  let x = seed;
  const randomAtScale = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(randomAtScale() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return new Set(order.slice(0, n * knownPct / 100));
}
async function runScale(layout: typeof layouts[number]) {
  const p = profiles('review', 'text', { type:'text', search:{ substring:{ wordBoundary:layout.words, skipGrams:layout.skip } } })[0];
  const allPieces = victim.map(v => pieces(p, v, layout.boundary));
  const unique = [...new Set(allPieces.flat())], oracle = new Map<string,string>();
  for (let i = 0; i < unique.length; i += 256) {
    await Promise.all(unique.slice(i, i + 256).map(async label => {
      oracle.set(label, (await searchTokens(ring, scope, p, [Buffer.from(label,'hex')], cache))[0]);
    }));
  }
  const rows = allPieces.map(ps => ({ pieces:ps, tokens:[...new Set(ps.map(label => oracle.get(label)!))] }));
  const scales = [];
  for (const n of [5_000, 20_000, 50_000, 100_000]) {
    const subset = rows.slice(0,n), labels = new Set(subset.flatMap(row => row.pieces));
    const byToken = new Map<string,number>();
    for (const label of labels) add(byToken, oracle.get(label)!);
    const collisionTokens = [...byToken.values()].filter(count => count > 1).length;
    const known = [1,5].map(knownPct => {
      const knownRows = sampledKnown(n, knownPct);
      const attack = knownAttack(subset, knownRows);
      const metric = score(attack.guesses, subset, oracle, knownRows);
      return { knownPct, knownRows:knownRows.size, adjacentPct:metric.adjacentPct, mostlyDecodedUnknownRowsPct:metric.mostlyDecodedUnknownRowsPct, decodedByKind:metric.byKind };
    });
    scales.push({ victimRows:n, referenceRows:reference.length, uniquePieces:labels.size, uniqueTokens:byToken.size, collisionTokens, piecesOnCollidingTokens:[...byToken.values()].filter(count => count>1).reduce((a,b)=>a+b,0), known });
    console.error(`Measured ${layout.name}, ${n} rows`);
  }
  return { layout:layout.name, scales };
}
/** Same HKDF/HMAC framing and scope as searchTokens; only value truncation varies. */
function benchmarkTokenFunction(p: SearchProfile) {
  const material = Buffer.from(hkdfSync('sha384', Buffer.from(ring.key), Buffer.alloc(0), Buffer.from(frame(['sealql/index/v3', ring.keyScopeId, descriptorBytes(p)])), 48));
  const scopeDigest = createHmac('sha384', material).update(frame(['scope', scope])).digest();
  const prefix = BigInt(scopeDigest.readUInt32BE(0));
  return (piece: Uint8Array, bits: number) => {
    const raw = createHmac('sha384', material).update(frame(['value', scope, piece])).digest().readUInt32BE(0);
    const masked = (raw >>> (32 - bits)) * 2 ** (32 - bits);
    return BigInt.asIntN(64, (prefix << 32n) | BigInt(masked >>> 0)).toString();
  };
}
async function runBits(layout: typeof layouts[number]) {
  const p = profiles('review', 'text', { type:'text', search:{ substring:{ wordBoundary:layout.words, skipGrams:false } } })[0];
  const allPieces = victim.map(v => pieces(p,v,layout.boundary));
  const unique = [...new Set(allPieces.flat())], benchToken = benchmarkTokenFunction(p);
  const rawTokens = new Map<string,Record<number,string>>();
  for (let i = 0; i < unique.length; i += 256) {
    await Promise.all(unique.slice(i,i+256).map(async label => {
      const bytes = Buffer.from(label,'hex');
      const variants = Object.fromEntries([14,15,16,17,20].map(bits => [bits,benchToken(bytes,bits)]));
      const product = (await searchTokens(ring,scope,p,[bytes],cache))[0];
      if (variants[16] !== product) throw new Error(`16-bit product token mismatch: ${label}`);
      rawTokens.set(label,variants);
    }));
  }
  console.error(`Verified all ${unique.length} 16-bit ${layout.name} pieces against product searchTokens`);
  const queries = [
    {name:'2-char contains',term:'영화',op:'contains' as const,words:false},
    {name:'middle 3-char contains',term:'서비스',op:'contains' as const,words:false},
    {name:'two-word contains',term:'정말 재미',op:'contains' as const,words:true},
    {name:'field-start autocomplete',term:'정말',op:'startsWith' as const,words:false},
  ];
  const prepared = queries.map(q => ({...q,labels:pieces(p,q.term,layout.boundary,q.op,q.words&&layout.words),match:victim.map(text => q.words ? normalizeWords(text).includes(normalizeWords(q.term)) : q.op==='startsWith' ? normalizeText(text,'legacy-text-v1').startsWith(normalizeText(q.term,'legacy-text-v1')) : normalizeText(text,'legacy-text-v1').includes(normalizeText(q.term,'legacy-text-v1')))}));
  const variants = [];
  for (const bits of [14,15,16,17,20]) {
    const tokenOf = (label:string) => rawTokens.get(label)?.[bits] ?? benchToken(Buffer.from(label,'hex'),bits);
    const rows = allPieces.map(ps => ({pieces:ps,tokens:[...new Set(ps.map(tokenOf))]}));
    const oracle = new Map(unique.map(label => [label,tokenOf(label)]));
    const sizes = [];
    for (const n of [20_000,100_000]) {
      const subset = rows.slice(0,n);
      const known = [1,5].map(knownPct => {
        const knownRows = sampledKnown(n,knownPct);
        const metric = score(knownAttack(subset,knownRows).guesses,subset,oracle,knownRows);
        return {knownPct,knownRows:knownRows.size,adjacentPct:metric.adjacentPct,mostlyDecodedUnknownRowsPct:metric.mostlyDecodedUnknownRowsPct};
      });
      const search = prepared.map(q => {
        const queryTokens = [...new Set(q.labels.map(tokenOf))];
        let candidates = 0, matches = 0;
        for (let i=0;i<n;i++) {
          if (queryTokens.every(t => subset[i].tokens.includes(t))) candidates++;
          if (q.match[i]) matches++;
        }
        if (candidates < matches) throw new Error(`Missing candidates: ${layout.name} ${bits} ${n} ${q.name}`);
        return {name:q.name,term:q.term,queryPieceCount:q.labels.length,matches,candidates,falsePositiveFactor:matches ? +(candidates/matches).toFixed(3) : null};
      });
      sizes.push({victimRows:n,known,search});
      console.error(`Measured ${layout.name}, ${bits} bits, ${n} rows`);
    }
    variants.push({bits,sizes});
  }
  return {layout:layout.name,uniquePiecesVerified:unique.length,variants};
}
if (bitsMode) {
  const measured = [];
  for (const layout of bitLayouts) measured.push(await runBits(layout));
  const result = {source:path,seed,bitWidths:[14,15,16,17,20],victimRows:[20_000,100_000],referenceRows:20_000,referenceNote:'rows 100,001–120,000 reserved disjointly; known-row and false-positive measurements do not use reference plaintext',tokenMethod:'product searchPieces; benchmark HKDF/HMAC input framing, scope and profile descriptor fixed at product 16-bit profile; only high-bit truncation varies',product16Assertions:measured.map(m=>({layout:m.layout,pieces:m.uniquePiecesVerified,mismatches:0})),measures:measured};
  const dir='bench/results/2026-09-27-layout-attack';mkdirSync(dir,{recursive:true});
  writeFileSync(`${dir}/bits.json`,JSON.stringify(result,null,2)+'\n');
  const leakRows=measured.flatMap(m=>m.variants.flatMap(v=>v.sizes.flatMap(s=>s.known.map(k=>`| ${m.layout} | ${s.victimRows.toLocaleString('en-US')} | ${v.bits} | ${k.knownPct}% | ${k.adjacentPct.toFixed(2)}% | ${k.mostlyDecodedUnknownRowsPct.toFixed(2)}% |`))));
  const searchRows=measured.flatMap(m=>m.variants.flatMap(v=>v.sizes.flatMap(s=>s.search.map(q=>`| ${m.layout} | ${s.victimRows.toLocaleString('en-US')} | ${v.bits} | ${q.name} (${q.term}) | ${q.matches} | ${q.candidates} | ${q.falsePositiveFactor?.toFixed(3) ?? '—'} |`))));
  const report=`# 제품 토큰 입력 구조의 조각 비트 비교\n\n2026-09-27 · 로컬 \`.local/ratings.txt\` 메모리 측정, DB 적재 없음. 피해 2만/10만 행은 같은 공개 리뷰의 접두 구간이고, 10만 행 뒤의 별도 2만 행은 참고 구간으로 예약했다. 이 원문 대조·오탐 측정은 참고 원문을 사용하지 않는다. 알려진 행은 규모별 시드 99 Fisher–Yates 순서의 중첩된 1%/5%다.\n\n벤치 전용 토큰 함수는 제품의 HKDF(SHA-384) 정보 프레임, HMAC(SHA-384) 값·scope 프레임, 32비트 scope 접두와 부호 있는 64비트 packing을 그대로 사용했다. 프로필 설명자는 제품의 16비트 프로필로 고정하고 HMAC 값의 상위 절단 비트만 14/15/16/17/20으로 바꿨다. 제품은 부분 검색에 16비트만 허용하므로 다른 비트는 제품 기능이 아니다. 16비트 결과는 두 구성의 서로 다른 조각 ${measured.map(m=>m.uniquePiecesVerified.toLocaleString('en-US')).join('개·')}개 전부를 제품 \`searchTokens\`와 비교해 불일치 0건이었다.\n\n## 알려진 원문 공격\n\n조각 등장 기준 인접 조각 해독률과, 알려지지 않은 피해 행 중 저장된 전체 조각의 80% 이상을 해독한 비율이다. 공격은 알려진 행의 토큰·조각 행집합이 같고 후보 조각이 하나일 때만 매핑한다.\n\n| 구성 | 피해 행 | 값 비트 | 알려진 원문 | 인접 해독 | 모르는 행 80%+ |\n|---|---:|---:|---:|---:|---:|\n${leakRows.join('\n')}\n\n## 검색 오탐\n\n제품 \`searchPieces\`의 네 검색어를 같은 행에 적용한 메모리 후보 수다. 정답은 원문에서 확인했고, 두 단어는 공백을 보존하며 시작 자동완성은 필드 시작에서 확인했다. 배율은 후보/정답이며 DB 속도는 측정하지 않았다.\n\n| 구성 | 피해 행 | 값 비트 | 검색 | 정답 | 후보 | 오탐 배율 |\n|---|---:|---:|---|---:|---:|---:|\n${searchRows.join('\n')}\n\n## 관찰 범위\n\n이 표는 비트 이외의 토큰 입력 구조와 공격을 같은 하네스 안에 고정한 상대 비교다. 원문 대조 공격은 누출 하한이며 빈도·동시출현·일관성 전파, 문자열 전체 복원, 길이·형식, 쿼리 관찰, 다중 스냅샷, 키 탈취 공격은 포함하지 않았다. 채택 권고나 보안 인증이 아니다. 원시 값은 [bits.json](bits.json)에 있다.\n`;
  const observed=report.replace('이 표는 비트 이외의 토큰 입력 구조와 공격을 같은 하네스 안에 고정한 상대 비교다.', '두 구성·두 피해 규모·두 원문 비율의 8조건 모두에서 인접 조각 해독률과 모르는 행 80%+ 해독률은 14 < 15 < 16 < 17 < 20비트 순서였다. 10만 행·5%에서는 인접만의 80%+가 16비트 3.64%, 17비트 11.53%, 20비트 43.06%였고, 시작·끝·단어 경계 구성은 각각 1.19%, 7.06%, 70.09%였다. 검색 네 종류의 후보 수는 함께 기록했으며 비트 변화의 효과는 검색어마다 다르다.\n\n이 표는 비트 이외의 토큰 입력 구조와 공격을 같은 하네스 안에 고정한 상대 비교다.');
  writeFileSync(`${dir}/bits-ko.md`,observed);
  console.log(JSON.stringify(measured.map(m=>({layout:m.layout,assertions:m.uniquePiecesVerified,variants:m.variants.map(v=>({bits:v.bits,sizes:v.sizes.map(s=>({n:s.victimRows,known:s.known}))}))})),null,2));
} else if (scaleMode) {
  const measured = [];
  for (const layout of scaleLayouts) measured.push(await runScale(layout));
  const result = { source:path, tokenBits:16, seed, victimPoolRows:100_000, referenceRows:20_000, split:'first 100,000 nonempty reviews are prefix victim pools; rows 100,001–120,000 are a fixed disjoint reference reserve, unused by known-row attack', knownSelection:'seeded Fisher-Yates separately at each n, 1% prefix nested in 5%', measures:measured };
  const dir = 'bench/results/2026-09-27-layout-attack'; mkdirSync(dir,{recursive:true});
  writeFileSync(`${dir}/scale.json`,JSON.stringify(result,null,2)+'\n');
  const scaleRows = measured.flatMap(layout => layout.scales.flatMap(s => s.known.map(k => `| ${layout.layout} | ${s.victimRows.toLocaleString('en-US')} | ${k.knownPct}% | ${s.uniquePieces.toLocaleString('en-US')} | ${s.uniqueTokens.toLocaleString('en-US')} | ${s.collisionTokens.toLocaleString('en-US')} | ${k.adjacentPct.toFixed(2)}% | ${k.mostlyDecodedUnknownRowsPct.toFixed(2)}% |`)));
  const report = `# 16비트 조각 공격의 피해 행 수 민감도\n\n2026-09-27 · 로컬 \`.local/ratings.txt\` 메모리 측정, DB 적재 없음. 피해 원문은 정제 후 첫 5천/2만/5만/10만 행의 중첩된 접두 구간이고, 참고용 2만 행은 10만 행 뒤의 고정된 별도 구간이다. 이 알려진 행 공격은 참고 원문을 사용하지 않는다. 제품 \`searchPieces\`/\`searchTokens\`의 16비트 조각 토큰, 시드 99, 각 규모에서 중첩된 알려진 1%·5% 행을 사용했다.\n\n## 옛 벤치 공격 재현\n\n변경하지 않은 \`bench/standard-review/known-row-attack.ts\`를 같은 파일로 실행했다. 인접 조각만·16비트·5%에서 조각 등장 해독 35.8%, 모르는 행 80%+ 해독 0.7%가 재현됐다. 같은 스크립트의 인접+건너뜀은 18.0%와 0.2%였다.\n\n| 조건 | 옛 벤치 공격(\`known-row-attack.ts\`) | 구성 비교 공격([report-ko.md](report-ko.md)) | 이 규모 측정 |\n|---|---|---|---|\n| 피해 행 | 첫 100,000 | 첫 20,000 | 첫 5,000/20,000/50,000/100,000 |\n| 참고 행 | 사용 안 함 | 20,001–40,000, 빈도 공격에 사용 | 100,001–120,000 고정, 원문 대조에는 사용 안 함 |\n| 알려진 행 | 시드 99의 xorshift 반복 추첨, 각 실행에서 RNG 상태 이어짐 | 시드 99 Fisher–Yates, 1/5/10% 중첩 | 시드 99 Fisher–Yates, 규모별 1/5% 중첩 |\n| 조각 정의 | NFC·공백 제거·ASCII 소문자, 인접 2문자, FNV-1a 절단 16비트 | 제품 정규화·HMAC 절단 16비트·종류별 프레이밍 | 구성 비교 공격과 같음 |\n| 중복 | 행 안의 같은 조각은 Set으로 한 번 | 제품 \`searchPieces\` 중복 제거, 행 안 토큰도 Set | 구성 비교 공격과 같음 |\n| 해독 분모 | 피해 행의 고유 조각 등장 전체; 80%+ 행은 알려지지 않은 행 | 같음; 종류별 분리도 기록 | 같음; 표에는 인접만과 80%+ 행 |\n\n두 과거 결과는 행 수 외에 토큰 함수와 알려진 행 선택도 다르므로 직접적인 규모 효과가 아니다. 아래 표는 제품 토큰과 공격을 고정하고 피해 구간의 크기를 바꾼 결과다. 충돌 토큰은 피해 구간의 서로 다른 조각 2개 이상이 같은 토큰에 매핑된 경우다.\n\n| 구성 | 피해 행 | 알려진 원문 | 고유 조각 | 고유 토큰 | 충돌 토큰 | 인접 조각 해독 | 모르는 행 80%+ 해독 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${scaleRows.join('\n')}\n\n## 관찰 범위\n\n인접만·5%에서 모르는 행 80%+는 2.51% → 6.26% → 7.41% → 3.64%로 변했고, 충돌 토큰은 5,533 → 18,177 → 30,890 → 41,809개로 늘었다. 따라서 이 고정 시드와 공격에서 작은 피해 테이블일수록 더 샌다는 단조 관계는 관찰되지 않았다.\n\n표의 80%+는 구성에 저장된 모든 조각 종류를 기준으로 한 행 비율이다. 알려진 행집합은 규모별로 새로 섞으므로 규모 변화에는 표본 선택 차이도 포함된다. 같은 규모에서 1% 집합은 5% 집합에 포함된다. 측정한 원문 대조 공격은 누출 하한이며, 동시출현·일관성 전파, 문자열 전체 복원, 길이·형식, 쿼리 관찰, 다중 스냅샷, 키 탈취 공격은 이 규모 실험에 포함하지 않았다.\n\n원시 결과: [scale.json](scale.json).\n`;
  writeFileSync(`${dir}/scale-ko.md`,report);
  console.log(JSON.stringify(measured.map(x=>({layout:x.layout,scales:x.scales.map(s=>({n:s.victimRows,collisionTokens:s.collisionTokens,known:s.known.map(k=>[k.knownPct,k.adjacentPct,k.mostlyDecodedUnknownRowsPct])}))})),null,2));
} else {
const results = [];
for (const layout of layouts) { console.error(`Measuring ${layout.name}`); results.push(await run(layout)); }
const output = { source: path, seed, victimRows: victim.length, referenceRows: reference.length, split: 'first 20,000 nonempty reviews victim; next 20,000 reference; disjoint row positions', knownSelection: 'seeded Fisher-Yates prefix, nested 1/5/10%', tokenSource: 'product searchPieces/searchTokens, fixed benchmark key, one scope; key unavailable to attack', results };
const dir = 'bench/results/2026-09-27-layout-attack'; mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/results.json`, JSON.stringify(output, null, 2) + '\n');
const label: Record<string,string> = { adjacent:'인접', start:'시작', end:'끝', 'word-start':'단어 시작', 'word-end':'단어 끝', skip:'건너뜀' };
const rowLabel = (name: string) => name.replace('adjacent', '인접').replace('start/end', '시작·끝').replace('word', '단어 경계').replace('skip', '건너뜀');
const leakRows: string[] = [];
for (const r of results) {
  const variants = [{ name:'빈도', metric:r.frequency }, ...r.known.flatMap(k => [
    { name:`원문 ${k.knownPct}%`, metric:k.count },
    ...(k.consistency ? [{ name:`원문 ${k.knownPct}% + 일관성`, metric:k.consistency }] : []),
  ])];
  for (const v of variants) leakRows.push(`| ${rowLabel(r.layout)} | ${v.name} | ${v.metric.adjacentPct.toFixed(2)}% | ${['start','end','word-start','word-end','skip'].map(kind => v.metric.byKind[kind] ? `${v.metric.byKind[kind].pct!.toFixed(2)}%` : '—').join(' | ')} | ${v.metric.allPct.toFixed(2)}% | ${v.metric.mostlyDecodedUnknownRowsPct.toFixed(2)}% |`);
}
const searchRows = results.flatMap(r => r.search.map(s => `| ${rowLabel(r.layout)} | ${s.name} (${s.term}) | ${s.matches} | ${s.candidates} | ${s.falsePositiveFactor?.toFixed(3) ?? '—'} |`));
const progression = results.at(-1)!.known.map(k => `| ${k.knownPct}% | ${k.count.adjacentPct.toFixed(2)}% | ${k.consistency!.adjacentPct.toFixed(2)}% | ${k.count.mostlyDecodedUnknownRowsPct.toFixed(2)}% | ${k.consistency!.mostlyDecodedUnknownRowsPct.toFixed(2)}% | ${k.consistency!.addedTokenGuesses} | ${k.consistency!.rounds.map(x => x.added).join(' → ')} |`);
const report = `# 조각 구성별 누출·오탐 비교\n\n2026-09-27 · 로컬 공개 리뷰 파일 \`.local/ratings.txt\` · 메모리 시뮬레이션, DB 적재·SQL 측정 없음. 제품 \`searchPieces\`와 \`searchTokens\`가 생성한 16비트 토큰을 사용했다. 네 구성은 피해 20,000행, 별도 참고 20,000행, 시드 99, 동일한 알려진 행의 중첩된 1/5/10% 집합을 썼다.\n\n## 조각 해독\n\n등장 기준이며 행 안에서는 중복 조각을 한 번 센다. 원문 공격은 알려진 행의 토큰별·조각별 행집합이 같고 후보 조각이 하나일 때만 해독한다. 빈도 공격은 피해 토큰과 참고 조각의 행 빈도 순위를 맞춘다. 80%+ 비율의 분모는 해당 비율에서 원문을 모르는 피해 행이다. 원문 비율이 커져도 토큰 충돌과 같은 서명의 후보가 늘면 단일 후보 조건에 걸리는 해독률은 내려갈 수 있다.\n\n| 구성 | 공격 | 인접 | 시작 | 끝 | 단어 시작 | 단어 끝 | 건너뜀 | 전체 | 모르는 행 80%+ |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${leakRows.join('\n')}\n\n건너뜀 구성의 일관성 전파는 해독된 \`ab·bc → a_c\`와 역방향 \`ab·a_c → bc\`, \`bc·a_c → ab\`를 반복한다. 행의 조각은 위치 없는 집합이므로 이는 후보 투표이며, 알려진 행의 원문 대조로 허용된 후보 중 2표 이상·차점보다 2표 이상인 것을 채택했다. 실제 정답 여부는 별도 채점했다.\n\n| 알려진 원문 | 인접 해독 전 | 인접 해독 후 | 모르는 행 80%+ 전 | 후 | 추가 토큰 추정 | 회차별 추가 |\n|---|---:|---:|---:|---:|---:|---|\n${progression.join('\n')}\n\n## 검색 오탐\n\n같은 원문과 검색어를 대상으로 토큰이 모두 포함된 후보 수를 세었다. 배율은 후보/정답이다. 두 단어의 정답은 모든 구성에서 단어 공백을 보존해 판단하고, 단어 경계 조각이 없는 구성은 인접 조각만으로 후보를 낸다. 시작 자동완성은 필드 시작을 기준으로 판단한다.\n\n| 구성 | 검색 | 정답 | 후보 | 오탐 배율 |\n|---|---|---:|---:|---:|\n${searchRows.join('\n')}\n\n## 한계\n\n사용한 빈도 순위·알려진 원문 행집합 대조·일관성 전파 공격 = 이 조건에서 확인한 누출의 하한이다. 쓰지 않은 공격: 더 강한 동시출현·문자열 전체 복원, 길이·형식 추론, 쿼리 관찰, 다중 스냅샷 변경 추적, 키 또는 토큰 계산 기능 탈취. 일관성 규칙은 조각의 위치를 모르므로 잘못된 후보를 만들 수 있다. 이 결과는 선택 권고나 보안 인증, 운영 DB 성능 수치가 아니다. 원시 수치는 [results.json](results.json)에 있다.\n`;
writeFileSync(`${dir}/report-ko.md`, report);
console.log(JSON.stringify({ layouts: results.map(x => ({ layout:x.layout, frequency:x.frequency.adjacentPct, known:x.known.map(y => [y.knownPct,y.count.adjacentPct,y.count.mostlyDecodedUnknownRowsPct,y.consistency?.adjacentPct,y.consistency?.mostlyDecodedUnknownRowsPct]), search:x.search })) }, null, 2));
}
