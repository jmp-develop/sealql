create or replace function "research_next_cast_55048".current_cast(ks bytea[], offs integer[], qlen integer, n integer, salt bytea, stamps bigint[], positions integer[], affix integer) returns boolean language plpgsql cost 1900 immutable strict parallel safe security invoker set search_path = pg_catalog as $seal$

declare wi integer; p integer; target integer; wanted bigint; ok boolean; first_ordinal integer := 1;
  ordinal integer; got_p integer; windows integer := cardinality(ks); stamp_count integer := cardinality(stamps);
  ordinals integer[]; latest integer[]; lo integer; hi integer; mid integer; found integer;
begin
  if n<qlen then return false; end if;
  for first_ordinal in 1..n loop
    wanted := substr(sha256(ks[1]||salt||int4send(first_ordinal)),1,8)::bigint;

    -- Native search avoids interpreter overhead on small arrays; large arrays
    -- use binary search, so long repeated values never rescan an entire proof.
    if stamp_count<=128 then found := array_position(stamps,wanted);
    else lo := 1; hi := stamp_count; found := null;
    while lo <= hi loop
      mid := lo + (hi-lo)/2;
      if stamps[mid] = wanted then found := mid; exit;
      elsif stamps[mid] < wanted then lo := mid+1; else hi := mid-1; end if;
    end loop; end if;
    if found is null then return false; end if;
    p := positions[found];
    if p>n-qlen or (affix=1 and p>0) then return false; end if;
    if affix=2 and p<n-qlen then continue; end if;
    ok := true;
    if windows>1 then for wi in 2..windows loop
      target := p+offs[wi];
      got_p := latest[wi];
      if got_p is null or got_p < target then
        for ordinal in coalesce(ordinals[wi],1)..n loop
          wanted := substr(sha256(ks[wi]||salt||int4send(ordinal)),1,8)::bigint;

    -- Native search avoids interpreter overhead on small arrays; large arrays
    -- use binary search, so long repeated values never rescan an entire proof.
    if stamp_count<=128 then found := array_position(stamps,wanted);
    else lo := 1; hi := stamp_count; found := null;
    while lo <= hi loop
      mid := lo + (hi-lo)/2;
      if stamps[mid] = wanted then found := mid; exit;
      elsif stamps[mid] < wanted then lo := mid+1; else hi := mid-1; end if;
    end loop; end if;
          if found is null then return false; end if;
          got_p := positions[found];
          if got_p>=target then
            if ordinals is not null then ordinals[wi] := ordinal+1; latest[wi] := got_p; end if;
            exit;
          end if;
        end loop;
      end if;
      if got_p<>target then ok := false; exit; end if;
    end loop; end if;
    if ok then return true; end if;
    -- Most rows finish at the first occurrence. Allocate reusable cursors only
    -- when another candidate must be tried; subsequent windows advance once.
    if ordinals is null then ordinals := array_fill(1,array[windows]); latest := array_fill(-1,array[windows]); end if;
  end loop;
  return false;
end
$seal$