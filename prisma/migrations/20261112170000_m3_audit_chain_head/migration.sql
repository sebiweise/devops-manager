-- CreateTable
CREATE TABLE "AuditChainHead" (
    "installationId" BIGINT NOT NULL,
    "seq" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "sealedAfterSeq" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AuditChainHead_pkey" PRIMARY KEY ("installationId")
);

-- Every existing chain gets its head; its rows were written before results
-- were sealed, so they stay "unsealed" and every later final row must be
-- sealed.
INSERT INTO "AuditChainHead" ("installationId", "seq", "hash", "sealedAfterSeq", "updatedAt")
SELECT DISTINCT ON ("installationId") "installationId", "seq", "hash", "seq", CURRENT_TIMESTAMP
FROM "AuditLog"
ORDER BY "installationId", "seq" DESC;

-- The head only moves forward: no delete, no lower seq, no other chain, and
-- the seal cutoff never changes.
CREATE FUNCTION "audit_chain_head_forward_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AuditChainHead rows cannot be deleted';
  END IF;
  IF NEW."installationId" <> OLD."installationId"
     OR NEW."seq" <= OLD."seq"
     OR NEW."sealedAfterSeq" <> OLD."sealedAfterSeq" THEN
    RAISE EXCEPTION 'AuditChainHead only moves forward';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AuditChainHead_forward_only"
BEFORE UPDATE OR DELETE ON "AuditChainHead"
FOR EACH ROW EXECUTE FUNCTION "audit_chain_head_forward_only"();
