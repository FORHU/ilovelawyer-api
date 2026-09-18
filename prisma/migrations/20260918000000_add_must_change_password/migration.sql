-- AlterTable
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every USER-role account that already exists as of this migration was created
-- under the old, weaker password policy. Flag it once so AuthSvc.login routes it through
-- the forced update on its next sign-in. Deliberately excludes ADMIN accounts — those are
-- bootstrap/seeded operator accounts (see prisma/seeders/admin.seeder.ts), not signups this
-- policy was written for, and gating them here risks locking staff out of production with
-- no self-service recovery path in ilovelawyer-admin. Accounts with no password (Google-only)
-- have nothing to update, so they're left alone too. Any row inserted after this migration
-- runs gets the column's default (false) instead, since signup now enforces the strong
-- policy already.
UPDATE "User" SET "mustChangePassword" = true WHERE "password" IS NOT NULL AND "role" = 'USER';
