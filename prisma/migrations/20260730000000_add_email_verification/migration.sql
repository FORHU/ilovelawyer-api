ALTER TABLE "User" ADD COLUMN "emailVerificationCode" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerificationExpiry" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "emailVerificationAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "emailVerificationLastSentAt" TIMESTAMP(3);

-- Backfill: Login now blocks on isEmailVerified, so every account that
-- already exists is grandfathered in as verified — the gate only applies to
-- signups from this point forward. See docs/adr/0001-email-verification-otp.md.
UPDATE "User" SET "isEmailVerified" = true WHERE "isEmailVerified" = false;
