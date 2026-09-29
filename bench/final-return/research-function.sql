CREATE FUNCTION research_u.pb_4_match(ks bytea[],offs int[],qlen int,n int,salt bytea,stamps bigint[],positions int[],affix int) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
 DECLARE first_i int:=1; i int; wi int; idx int; p int; target_p int; got_p int; tag bigint; ok bool;
 BEGIN
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
 END $fn$