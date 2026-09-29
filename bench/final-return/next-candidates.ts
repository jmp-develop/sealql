/** Unadopted candidates: SQL preparation only; this module never opens a DB. */
import assert from 'node:assert/strict';
import {registrationOf} from '../../src/adapters/drizzle/v0.45/native.js';
import type {Query} from './variants.js';

/** Arguments are compiler-generated SQL, not user-supplied SQL strings. */
export function firstOccurrenceSql(args: readonly string[], windows: number, fallback: string): string {
  assert.equal(args.length, 8);
  assert.ok(Number.isSafeInteger(windows) && windows > 0);
  const [keys, offsets, length, n, salt, stamps, positions, affix] = args;
  const at = (i: number) => `(${offsets})[${i}]`;
  const first = Array.from({length: windows}, (_, i) =>
    `(${positions})[pg_catalog.array_position(${stamps},(('x' OPERATOR(pg_catalog.||) pg_catalog.encode(pg_catalog.substr(pg_catalog.sha256(((${keys})[${i+1}] OPERATOR(pg_catalog.||) ${salt}) OPERATOR(pg_catalog.||) pg_catalog.int4send(1)),1,8),'hex'))::bit(64)::bigint))]`);
  // OFFSET 0 binds the array once per row: repeating the anchor expression in
  // each comparison would repeat its hash N times. This subplan's overhead is
  // part of the pending measurement, not an assumed improvement.
  const p = '(f.p[1] OPERATOR(pg_catalog.-) ' + at(1) + ')';
  const tests = [
    `${p} OPERATOR(pg_catalog.>=) 0`,
    `${p} OPERATOR(pg_catalog.<=) (${n} OPERATOR(pg_catalog.-) ${length})`,
    `(${affix} OPERATOR(pg_catalog.<>) 1 or ${p} OPERATOR(pg_catalog.=) 0)`,
    `(${affix} OPERATOR(pg_catalog.<>) 2 or ${p} OPERATOR(pg_catalog.=) (${n} OPERATOR(pg_catalog.-) ${length}))`,
    ...Array.from({length: windows}, (_, i) =>
      `f.p[${i+1}] OPERATOR(pg_catalog.=) (${p} OPERATOR(pg_catalog.+) ${at(i+1)})`),
  ];
  // NULL/missing first occurrences take ELSE, just like any failed sufficient
  // condition. Only a complete positional proof may bypass the original call.
  return `(case when (select ${tests.join(' and ')} from (select array[${first.join(',')}] as p offset 0) as f) then true else ${fallback} end)`;
}

/** Split only the trusted generated function call; quotes and nested calls are retained. */
function callArguments(text: string, open: number): {args: string[]; end: number} {
  const args: string[] = [];
  let depth = 1, brackets = 0, start = open+1, quote = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) { if (text[i+1] === quote) i++; else quote = ''; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '[') brackets++;
    else if (c === ']') brackets--;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      args.push(text.slice(start, i).trim());
      return {args, end: i+1};
    } else if (c === ',' && depth === 1 && brackets === 0) {
      args.push(text.slice(start, i).trim()); start = i+1;
    }
  }
  throw new Error('Unclosed compiler-generated proof call');
}

/**
 * Apply to a captured current-product count/list query. N comes from the
 * compiler's offset array, without inspecting values or choosing an operator
 * or window-count-specific implementation. Bind values and numbering stay exact.
 * LIKE has its own program and remains unchanged in this candidate.
 */
export function firstOccurrenceVariant(query: Query): Query {
  const calls = /"(?:[^"]|"")+"\."sealql_match_positions"\s*\(/g;
  let result = '', cursor = 0, match: RegExpExecArray | null;
  while ((match = calls.exec(query.text))) {
    const {args, end} = callArguments(query.text, calls.lastIndex-1);
    assert.equal(args.length, 8);
    const offsetBind = /^\$(\d+)::integer\[\]$/.exec(args[1]);
    assert.ok(offsetBind, 'Unexpected compiler offset argument');
    const value = query.params[Number(offsetBind[1])-1];
    const offsets = Array.isArray(value) ? value :
      typeof value === 'string' && /^\{\d+(?:,\d+)*\}$/.test(value) ? value.slice(1,-1).split(',').map(Number) : [];
    assert.ok(offsets.length > 0 && offsets.every(x => Number.isSafeInteger(x) && x >= 0));
    result += query.text.slice(cursor, match.index) + firstOccurrenceSql(args, offsets.length, query.text.slice(match.index, end));
    cursor = end; calls.lastIndex = end;
  }
  return {text: result + query.text.slice(cursor), params: query.params};
}

/**
 * B: append to extraMigrationSql for an OWNED fresh test clone, before loading.
 * MAIN and the proof codec stay unchanged. ALTER does not rewrite old rows.
 * Caller derives the target from the owned clone's full-inline row sizes.
 */
export function toastTargetVariant(seal: object, target: number, reg = registrationOf(seal)): string[] {
  const index = reg.storage.index!;
  assert.ok(index && /^test_/.test(index.schema), 'Use an owned fresh test clone');
  assert.ok(Number.isInteger(target) && target >= 128 && target <= 8160);
  const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  return [`alter table ${quote(index.schema)}.${quote(index.name)} set (toast_tuple_target=${target})`];
}
