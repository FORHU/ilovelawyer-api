-- AI damages suggestions the lawyer deleted or renamed, so re-reading the case's documents on
-- "Refresh analysis" doesn't propose them again.
CREATE TABLE "DamageClaimDismissal" (
    "id"        TEXT NOT NULL,
    "caseId"    TEXT NOT NULL,
    "key"       TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DamageClaimDismissal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DamageClaimDismissal_caseId_key_key" ON "DamageClaimDismissal"("caseId", "key");

ALTER TABLE "DamageClaimDismissal" ADD CONSTRAINT "DamageClaimDismissal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
