/** Functions are installed explicitly through extraMigrationSql, never during a query. */
export function stampMigrationSql(schema: string): string[] {
  const ns = `"${schema.replaceAll('"', '""')}"`;
  const functionSql = (name: string, args: string, returns: string, body: string) =>
    `create or replace function ${ns}.${name}(${args}) returns ${returns} language plpgsql immutable strict parallel safe security invoker set search_path = pg_catalog as $seal$\n${body}\n$seal$`;
  const lookup = `
    lo := 1; hi := cardinality(stamps); found := 0;
    -- Native search avoids interpreter overhead on small arrays; large arrays
    -- use binary search, so long repeated values never rescan an entire proof.
    if hi<=128 then found := coalesce(array_position(stamps,wanted),0);
    else while lo <= hi loop
      mid := lo + (hi-lo)/2;
      if stamps[mid] = wanted then found := mid; exit;
      elsif stamps[mid] < wanted then lo := mid+1; else hi := mid-1; end if;
    end loop; end if;
    if found <> 0 and (positions[found] is null or positions[found] < 0 or positions[found] >= n) then
      raise exception using errcode='22023', message='Invalid search proof';
    end if;`;
  return [
    functionSql('sealql_piece_positions', 'k bytea, salt bytea, stamps bigint[], positions integer[], n integer', 'integer[]', `
declare ordinal integer := 1; lo integer; hi integer; mid integer; wanted bigint; found integer; result integer[] := '{}';
begin
  if octet_length(k) <> 32 or octet_length(salt) <> 16 or n < 0 or cardinality(stamps) <> cardinality(positions)
    or (cardinality(stamps) > 0 and (array_lower(stamps,1) <> 1 or array_lower(positions,1) <> 1)) then
    raise exception using errcode='22023', message='Invalid search proof';
  end if;
  while ordinal <= n loop
    wanted := (('x' || encode(substr(pg_catalog.sha256(k || salt || pg_catalog.int4send(ordinal)),1,8),'hex'))::bit(64)::bigint);
    ${lookup}
    exit when found = 0;
    if ordinal > 1 and positions[found] <= result[ordinal-1] then
      raise exception using errcode='22023', message='Invalid search proof';
    end if;
    result := array_append(result, positions[found]); ordinal := ordinal+1;
  end loop;
  return result;
end`),
    functionSql('sealql_run_positions', 'lists integer[], starts integer[], ends integer[], ids integer[], offs integer[], qlen integer, n integer', 'integer[]', `
declare wi integer; anchor integer := 1; first_i integer; p integer; target integer; cursors integer[]; result integer[] := '{}'; ok boolean;
begin
  if qlen < 1 or n < qlen then return result; end if;
  if cardinality(ids) = 0 or cardinality(ids) <> cardinality(offs) then
    raise exception using errcode='22023', message='Invalid search query';
  end if;
  cursors := array_fill(0,array[cardinality(ids)]);
  for wi in 1..cardinality(ids) loop
    if ids[wi] < 1 or ids[wi] > cardinality(starts) then
      raise exception using errcode='22023', message='Invalid search query';
    end if;
    cursors[wi] := starts[ids[wi]];
    if cursors[wi] > ends[ids[wi]] then return result; end if;
    if ends[ids[wi]]-starts[ids[wi]] < ends[ids[anchor]]-starts[ids[anchor]] then anchor := wi; end if;
  end loop;
  -- Every list is already materialized: start from the shortest one to avoid
  -- revisiting a long common prefix when a later literal window is rare.
  for first_i in starts[ids[anchor]]..ends[ids[anchor]] loop
    p := lists[first_i]-offs[anchor];
    if p < 0 then continue; end if;
    exit when p > n-qlen;
    ok := true;
    if cardinality(ids) > 1 then for wi in 1..cardinality(ids) loop
      if wi=anchor then continue; end if;
      target := p+offs[wi];
      while cursors[wi] <= ends[ids[wi]] and lists[cursors[wi]] < target loop cursors[wi] := cursors[wi]+1; end loop;
      if cursors[wi] > ends[ids[wi]] then return result; end if;
      if lists[cursors[wi]] <> target then ok := false; exit; end if;
    end loop; end if;
    if ok then result := array_append(result,p); end if;
  end loop;
  return result;
end`),
    functionSql('sealql_match_positions', 'ks bytea[], offs integer[], qlen integer, n integer, salt bytea, stamps bigint[], positions integer[], affix integer', 'boolean', `
declare wi integer; p integer; target integer; wanted bigint; ok boolean; first_ordinal integer := 1; previous integer := -1;
  ordinals integer[]; latest integer[]; lo integer; hi integer; mid integer; found integer;
begin
  if cardinality(ks)=0 or cardinality(ks)<>cardinality(offs) or offs[1]<>0 or qlen<2 or n<0
    or affix not in (0,1,2) or octet_length(salt)<>16 or cardinality(stamps)<>cardinality(positions)
    or array_lower(ks,1)<>1 or array_lower(offs,1)<>1
    or (cardinality(stamps)>0 and (array_lower(stamps,1)<>1 or array_lower(positions,1)<>1)) then
    raise exception using errcode='22023',message='Invalid search proof';
  end if;
  if n<qlen then return false; end if;
  if cardinality(ks)>1 then
    ordinals := array_fill(1,array[cardinality(ks)]); latest := array_fill(-1,array[cardinality(ks)]);
  end if;
  loop
    wanted := (('x'||encode(substr(sha256(ks[1]||salt||int4send(first_ordinal)),1,8),'hex'))::bit(64)::bigint);
    ${lookup}
    if found=0 then return false; end if;
    p := positions[found];
    if p<=previous then raise exception using errcode='22023',message='Invalid search proof'; end if;
    previous := p; first_ordinal := first_ordinal+1;
    if p>n-qlen or (affix=1 and p>0) then return false; end if;
    if affix=2 and p<n-qlen then continue; end if;
    ok := true;
    if cardinality(ks)>1 then for wi in 2..cardinality(ks) loop
      target := p+offs[wi];
      while latest[wi] < target loop
        wanted := (('x'||encode(substr(sha256(ks[wi]||salt||int4send(ordinals[wi])),1,8),'hex'))::bit(64)::bigint);
        ${lookup}
        if found=0 then return false; end if;
        if positions[found] <= latest[wi] then
          raise exception using errcode='22023',message='Invalid search proof';
        end if;
        latest[wi] := positions[found]; ordinals[wi] := ordinals[wi]+1;
      end loop;
      if latest[wi]<>target then ok := false; exit; end if;
    end loop; end if;
    if ok then return true; end if;
  end loop;
end`),
    functionSql('sealql_match_like', 'ks bytea[], kinds integer[], pattern integer[], n integer, salt bytea, stamps bigint[], positions integer[], single_salt bytea, single_stamps bigint[], single_positions integer[]', 'boolean', `
declare i integer; p integer; qlen integer; cursor integer := 1; windows integer; ids integer[]; offs integer[];
  lists integer[] := '{}'; starts integer[] := '{}'; ends integer[] := '{}'; locations integer[];
  frontier boolean[]; next_frontier boolean[]; reachable boolean;
begin
  if n<0 or cardinality(ks)<>cardinality(kinds) then
    raise exception using errcode='22023',message='Invalid search query';
  end if;
  if cardinality(ks)>0 then for i in 1..cardinality(ks) loop
    if kinds[i]=1 then locations := ${ns}.sealql_piece_positions(ks[i],single_salt,single_stamps,single_positions,n);
    elsif kinds[i]=2 then locations := ${ns}.sealql_piece_positions(ks[i],salt,stamps,positions,n);
    else raise exception using errcode='22023',message='Invalid search query'; end if;
    starts := array_append(starts,cardinality(lists)+1); lists := lists || locations; ends := array_append(ends,cardinality(lists));
  end loop; end if;
  frontier := array_fill(false,array[n+1]); frontier[1] := true;
  while cursor<=cardinality(pattern) loop
    qlen := pattern[cursor]; cursor := cursor+1;
    next_frontier := array_fill(false,array[n+1]);
    if qlen=-1 then
      reachable := false;
      for p in 0..n loop reachable := reachable or frontier[p+1]; next_frontier[p+1] := reachable; end loop;
    elsif qlen=-2 then
      if n>0 then for p in 1..n loop next_frontier[p+1] := frontier[p]; end loop; end if;
    else
      windows := pattern[cursor]; cursor := cursor+1;
      if qlen<1 or windows is null or windows<1 or cursor+windows*2-1>cardinality(pattern) then
        raise exception using errcode='22023',message='Invalid search query';
      end if;
      ids := '{}'; offs := '{}';
      for i in 1..windows loop
        ids := array_append(ids,pattern[cursor]); offs := array_append(offs,pattern[cursor+1]); cursor := cursor+2;
      end loop;
      foreach p in array ${ns}.sealql_run_positions(lists,starts,ends,ids,offs,qlen,n) loop
        if frontier[p+1] then next_frontier[p+qlen+1] := true; end if;
      end loop;
    end if;
    frontier := next_frontier;
  end loop;
  return frontier[n+1];
end`),
    // Remove obsolete internal overloads when upgrading a previously installed companion.
    `drop function if exists ${ns}.sealql_match_like(bytea[],integer[],jsonb,integer,bytea,bigint[],integer[],bytea,bigint[],integer[])`,
    `drop function if exists ${ns}.sealql_run_positions(jsonb,integer[],integer[],integer,integer)`,
  ];
}
