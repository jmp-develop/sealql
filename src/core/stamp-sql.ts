/** Functions are installed explicitly through extraMigrationSql, never during a query. */
export function stampMigrationSql(schema: string): string[] {
  const ns = `"${schema.replaceAll('"', '""')}"`;
  const functionSql = (name: string, args: string, returns: string, body: string) =>
    `create or replace function ${ns}.${name}(${args}) returns ${returns} language plpgsql immutable strict parallel safe security invoker set search_path = pg_catalog as $seal$\n${body}\n$seal$`;
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
    lo := 1; hi := cardinality(stamps); found := 0;
    while lo <= hi loop
      mid := lo + (hi-lo)/2;
      if stamps[mid] = wanted then found := mid; exit;
      elsif stamps[mid] < wanted then lo := mid+1; else hi := mid-1; end if;
    end loop;
    exit when found = 0;
    if positions[found] is null or positions[found] < 0 or positions[found] >= n then
      raise exception using errcode='22023', message='Invalid search proof';
    end if;
    result := array_append(result, positions[found]); ordinal := ordinal+1;
  end loop;
  return result;
end`),
    functionSql('sealql_run_positions', 'lists jsonb, ids integer[], offs integer[], qlen integer, n integer', 'integer[]', `
declare i integer; p integer; starts integer[] := '{}'; counts integer[]; positions integer[];
begin
  if qlen < 1 or n < qlen then return starts; end if;
  if cardinality(ids) = 0 or cardinality(ids) <> cardinality(offs) then
    raise exception using errcode='22023', message='Invalid search query';
  end if;
  counts := array_fill(0, array[n-qlen+1]);
  for i in 1..cardinality(ids) loop
    select coalesce(array_agg(v::integer),'{}') into positions from jsonb_array_elements_text(lists->ids[i]) v;
    foreach p in array positions loop
      p := p-offs[i];
      if p >= 0 and p <= n-qlen then counts[p+1] := counts[p+1]+1; end if;
    end loop;
  end loop;
  for p in 0..n-qlen loop
    if counts[p+1] = cardinality(ids) then starts := array_append(starts,p); end if;
  end loop;
  return starts;
end`),
    functionSql('sealql_match_positions', 'ks bytea[], offs integer[], qlen integer, n integer, salt bytea, stamps bigint[], positions integer[], affix integer', 'boolean', `
 DECLARE first_i int:=1; i int; wi int; idx int; p int; target_p int; got_p int; tag bigint; ok bool;
 BEGIN
  IF cardinality(ks)=0 OR cardinality(ks)<>cardinality(offs) OR offs[1]<>0 OR qlen<2
    OR affix NOT IN (0,1,2) OR octet_length(salt)<>16 OR cardinality(stamps)<>cardinality(positions) THEN
    RAISE EXCEPTION USING errcode='22023',message='Invalid search proof';
  END IF;
  IF n<qlen THEN RETURN false;END IF;
  LOOP
   tag:=(('x'||encode(substr(sha256(ks[1]||salt||int4send(first_i)),1,8),'hex'))::bit(64)::bigint);
   idx:=array_position(stamps,tag);IF idx IS NULL THEN RETURN false;END IF;
   p:=positions[idx];IF p>n-qlen THEN RETURN false;END IF;
   IF affix=1 AND p>0 THEN RETURN false;END IF;
   IF affix=2 AND p<n-qlen THEN first_i:=first_i+1;CONTINUE;END IF;
   ok:=true;
   IF cardinality(ks)>1 THEN FOR wi IN 2..cardinality(ks) LOOP
    target_p:=p+offs[wi];i:=1;
    LOOP
     tag:=(('x'||encode(substr(sha256(ks[wi]||salt||int4send(i)),1,8),'hex'))::bit(64)::bigint);
     idx:=array_position(stamps,tag);IF idx IS NULL THEN ok:=false;EXIT;END IF;
     got_p:=positions[idx];IF got_p>=target_p THEN ok:=got_p=target_p;EXIT;END IF;i:=i+1;
    END LOOP;
    IF NOT ok THEN EXIT;END IF;
   END LOOP;END IF;
   IF ok THEN RETURN true;END IF;first_i:=first_i+1;
  END LOOP;
 END `),
    functionSql('sealql_match_like', 'ks bytea[], kinds integer[], pattern jsonb, n integer, salt bytea, stamps bigint[], positions integer[], single_salt bytea, single_stamps bigint[], single_positions integer[]', 'boolean', `
declare i integer; p integer; qlen integer; token jsonb; lists jsonb := '[]'; ids integer[]; offs integer[];
  frontier boolean[]; next_frontier boolean[]; reachable boolean;
begin
  if n < 0 or cardinality(ks) <> cardinality(kinds) or jsonb_typeof(pattern) <> 'array' then
    raise exception using errcode='22023', message='Invalid search query';
  end if;
  if cardinality(ks) > 0 then for i in 1..cardinality(ks) loop
    if kinds[i] = 1 then lists := lists || jsonb_build_array(to_jsonb(${ns}.sealql_piece_positions(ks[i],single_salt,single_stamps,single_positions,n)));
    elsif kinds[i] = 2 then lists := lists || jsonb_build_array(to_jsonb(${ns}.sealql_piece_positions(ks[i],salt,stamps,positions,n)));
    else raise exception using errcode='22023', message='Invalid search query'; end if;
  end loop; end if;
  frontier := array_fill(false,array[n+1]); frontier[1] := true;
  for token in select value from jsonb_array_elements(pattern) loop
    next_frontier := array_fill(false,array[n+1]);
    if token = '"%"'::jsonb then
      reachable := false;
      for p in 0..n loop reachable := reachable or frontier[p+1]; next_frontier[p+1] := reachable; end loop;
    elsif token = '"_"'::jsonb then
      if n > 0 then for p in 1..n loop next_frontier[p+1] := frontier[p]; end loop; end if;
    else
      qlen := (token->>'n')::integer;
      select array_agg(v::integer) into ids from jsonb_array_elements_text(token->'k') v;
      select array_agg(v::integer) into offs from jsonb_array_elements_text(token->'o') v;
      foreach p in array ${ns}.sealql_run_positions(lists,ids,offs,qlen,n) loop
        if frontier[p+1] then next_frontier[p+qlen+1] := true; end if;
      end loop;
    end if;
    frontier := next_frontier;
  end loop;
  return frontier[n+1];
end`),
  ];
}
