/** Functions are installed explicitly through extraMigrationSql, never during a query. */
export function stampMigrationSql(schema: string): string[] {
  const ns = `"${schema.replaceAll('"', '""')}"`;
  const functionSql = (name: string, args: string, returns: string, body: string, cost = 100) =>
    `create or replace function ${ns}.${name}(${args}) returns ${returns} language plpgsql cost ${cost} immutable strict parallel safe security invoker set search_path = pg_catalog as $seal$\n${body}\n$seal$`;
  const lookup = `
    -- Native search avoids interpreter overhead on small arrays; large arrays
    -- use binary search, so long repeated values never rescan an entire proof.
    if stamp_count<=128 then found := array_position(stamps,wanted);
    else lo := 1; hi := stamp_count; found := null;
    while lo <= hi loop
      mid := lo + (hi-lo)/2;
      if stamps[mid] = wanted then found := mid; exit;
      elsif stamps[mid] < wanted then lo := mid+1; else hi := mid-1; end if;
    end loop; end if;`;
  // One position-search algorithm, emitted with either a boolean affix contract
  // or a first-position interval contract. No extra call in ordinary predicates.
  const positionBody = (find: boolean) => `
declare wi integer; p integer; target integer; wanted bigint; ok boolean; first_ordinal integer := 1;
  ordinal integer; got_p integer; windows integer := cardinality(ks); stamp_count integer := cardinality(stamps);
  ordinals integer[]; latest integer[]; lo integer; hi integer; mid integer; found integer;
begin
  if n<qlen${find ? ' or minp>maxp' : ''} then return ${find ? 'null' : 'false'}; end if;
  for first_ordinal in 1..n loop
    wanted := (('x'||encode(substr(sha256(ks[1]||salt||int4send(first_ordinal)),1,8),'hex'))::bit(64)::bigint);
    ${lookup}
    if found is null then return ${find ? 'null' : 'false'}; end if;
    p := positions[found]${find ? '-offs[1]' : ''};
    ${find ? `if p>n-qlen or p>maxp then return null; end if;
    if p<minp then continue; end if;` : `if p>n-qlen or (affix=1 and p>0) then return false; end if;
    if affix=2 and p<n-qlen then continue; end if;`}
    ok := true;
    if windows>1 then for wi in 2..windows loop
      target := p+offs[wi];
      got_p := latest[wi];
      if got_p is null or got_p < target then
        for ordinal in coalesce(ordinals[wi],1)..n loop
          wanted := (('x'||encode(substr(sha256(ks[wi]||salt||int4send(ordinal)),1,8),'hex'))::bit(64)::bigint);
          ${lookup}
          if found is null then return ${find ? 'null' : 'false'}; end if;
          got_p := positions[found];
          if got_p>=target then
            if ordinals is not null then ordinals[wi] := ordinal+1; latest[wi] := got_p; end if;
            exit;
          end if;
        end loop;
      end if;
      if got_p<>target then ok := false; exit; end if;
    end loop; end if;
    if ok then return ${find ? 'p' : 'true'}; end if;
    -- Most rows finish at the first occurrence. Allocate reusable cursors only
    -- when another candidate must be tried; subsequent windows advance once.
    if ordinals is null then ordinals := array_fill(1,array[windows]); latest := array_fill(-1,array[windows]); end if;
  end loop;
  return ${find ? 'null' : 'false'};
end`;
  const positionArgs = 'ks bytea[], offs integer[], qlen integer, n integer, salt bytea, stamps bigint[], positions integer[]';
  return [
    functionSql('sealql_match_positions', `${positionArgs}, affix integer`, 'boolean', positionBody(false), 1900),
    functionSql('sealql_find_positions', `${positionArgs}, minp integer, maxp integer`, 'integer', positionBody(true), 1900),
    functionSql('sealql_match_like', 'ks bytea[], pattern integer[], n integer, salt bytea, stamps bigint[], positions integer[]', 'boolean', `
declare cursor integer := 1; size integer := cardinality(pattern); next_p integer := 0;
  qlen integer; part_len integer; windows integer; i integer; gap boolean := false;
  segment_keys bytea[]; offs integer[]; minp integer; maxp integer; p integer;
begin
  -- A % separates fixed-width segments. The earliest match of each segment
  -- leaves every later match available; only the final anchored segment must
  -- end at n. Underscores add width without creating an observed piece key.
  while cursor<=size loop
    if pattern[cursor]=-1 then
      gap := true; cursor := cursor+1;
      if cursor>size then return next_p<=n; end if;
    end if;
    qlen := 0; segment_keys := '{}'; offs := '{}';
    while cursor<=size and pattern[cursor]<>-1 loop
      part_len := pattern[cursor]; cursor := cursor+1;
      if part_len=-2 then qlen := qlen+1;
      else
        windows := pattern[cursor]; cursor := cursor+1;
        for i in 1..windows loop
          segment_keys := array_append(segment_keys,ks[pattern[cursor]]);
          offs := array_append(offs,qlen+pattern[cursor+1]); cursor := cursor+2;
        end loop;
        qlen := qlen+part_len;
      end if;
    end loop;
    if qlen>n-next_p then return false; end if;
    if cursor>size then
      minp := n-qlen; maxp := minp;
      if not gap and minp<>next_p then return false; end if;
    elsif gap then minp := next_p; maxp := n-qlen;
    else minp := next_p; maxp := next_p;
    end if;
    if cardinality(segment_keys)=0 then p := minp;
    else p := ${ns}.sealql_find_positions(segment_keys,offs,qlen,n,salt,stamps,positions,minp,maxp);
    end if;
    if p is null then return false; end if;
    next_p := p+qlen; gap := false;
  end loop;
  return next_p=n;
end`),
    // Remove internal materialization helpers and obsolete overloads on upgrade.
    `drop function if exists ${ns}.sealql_piece_positions(bytea,bytea,bigint[],integer[],integer)`,
    `drop function if exists ${ns}.sealql_run_positions(integer[],integer[],integer[],integer[],integer[],integer,integer)`,
    `drop function if exists ${ns}.sealql_match_like(bytea[],integer[],integer[],integer,bytea,bigint[],integer[],bytea,bigint[],integer[])`,
    `drop function if exists ${ns}.sealql_match_like(bytea[],integer[],jsonb,integer,bytea,bigint[],integer[],bytea,bigint[],integer[])`,
    `drop function if exists ${ns}.sealql_run_positions(jsonb,integer[],integer[],integer,integer)`,
  ];
}
