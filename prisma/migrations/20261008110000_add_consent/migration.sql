CREATE TYPE "ConsentPurpose" AS ENUM ('TERMS_OF_SERVICE', 'AI_PROCESSING', 'ANALYTICS', 'MARKETING');

CREATE TABLE "Consent" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "purpose"     "ConsentPurpose" NOT NULL,
  "version"     TEXT NOT NULL,
  "grantedAt"   TIMESTAMP(3) NOT NULL,
  "withdrawnAt" TIMESTAMP(3),
  "source"      TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Consent_userId_purpose_key" ON "Consent"("userId", "purpose");
CREATE INDEX "Consent_userId_idx" ON "Consent"("userId");

ALTER TABLE "Consent" ADD CONSTRAINT "Consent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
