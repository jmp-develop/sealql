-- Option (B) sketch, NOT executed. Generated per sealed table by customerSeal.migrationSql().
-- Write envelope (seal/patch output for one sealed column), bytes:
--   [0x84][u16 scopeLen][scope utf8][u16 rowLen][row utf8][u8 fieldNo]
--   repeat per token profile of this field: [u32 len][ASCII array literal '{t1,t2,...}']
--   [stored v3 envelope: 0x03 | nonce | ct+tag]   <- unchanged format/AAD
ALTER TABLE "customers" ADD COLUMN "memo_tok_s" bigint[], ADD COLUMN "name_tok_s" bigint[], ADD COLUMN "name_tok_e" bigint[];
CREATE INDEX "customers_seal_gin" ON "customers" USING gin ("name_tok_s", "memo_tok_s");
CREATE INDEX "customers_seal_name_e" ON "customers" ("tenant_id", ("name_tok_e")[1], "id");
ALTER TABLE "customers" ALTER COLUMN "memo_tok_s" SET STATISTICS 1000; -- as today

CREATE OR REPLACE FUNCTION "sealql_customers_w"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v bytea; o int; n int; s text; r text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."id" IS DISTINCT FROM OLD."id") THEN
    RAISE EXCEPTION USING ERRCODE = 'SQL01', MESSAGE = 'sealql: row/scope of a sealed row is immutable';
  END IF;
  -- one block per sealed column (generated); memo shown
  IF TG_OP = 'INSERT' OR NEW."memo_ct" IS DISTINCT FROM OLD."memo_ct" THEN
    v := NEW."memo_ct";
    IF v IS NULL THEN NEW."memo_tok_s" := NULL;
    ELSIF get_byte(v, 0) = 132 THEN
      o := 1; n := (get_byte(v,o) << 8) | get_byte(v,o+1); s := convert_from(substring(v FROM o+3 FOR n), 'UTF8'); o := o + 2 + n;
      n := (get_byte(v,o) << 8) | get_byte(v,o+1); r := convert_from(substring(v FROM o+3 FOR n), 'UTF8'); o := o + 2 + n;
      IF s <> NEW."tenant_id"::text OR r <> NEW."id"::text OR get_byte(v,o) <> 2 THEN
        RAISE EXCEPTION USING ERRCODE = 'SQL03', MESSAGE = 'sealql: sealed value bound to another row/scope/field';
      END IF;
      o := o + 1;
      n := (get_byte(v,o) << 24) | (get_byte(v,o+1) << 16) | (get_byte(v,o+2) << 8) | get_byte(v,o+3);
      NEW."memo_tok_s" := convert_from(substring(v FROM o+5 FOR n), 'UTF8')::bigint[]; o := o + 4 + n;
      NEW."memo_ct" := substring(v FROM o+1);
      IF get_byte(NEW."memo_ct", 0) <> 3 THEN RAISE EXCEPTION USING ERRCODE = 'SQL02', MESSAGE = 'sealql: malformed write envelope'; END IF;
    ELSIF TG_OP = 'INSERT' AND NEW."memo_tok_s" IS NOT NULL THEN
      NULL; -- COPY / data-only restore that carries its own tokens
    ELSIF TG_OP = 'UPDATE' AND NEW."memo_tok_s" IS DISTINCT FROM OLD."memo_tok_s" THEN
      NULL; -- explicit raw reindex writing tokens together with ciphertext
    ELSE
      RAISE EXCEPTION USING ERRCODE = 'SQL02', MESSAGE = 'sealql: memo_ct written without sealed.seal/patch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION "sealql_customers_w"() IS 'sealql:v1:<definition fingerprint>';
CREATE TRIGGER "sealql_customers_w" BEFORE INSERT OR UPDATE OF "name_ct", "memo_ct", "score_ct", "tenant_id", "id"
  ON "customers" FOR EACH ROW EXECUTE FUNCTION "sealql_customers_w"();
