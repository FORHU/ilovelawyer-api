-- Adds LAWYER to Role, on its own: Postgres won't let a transaction use an enum value it added,
-- so the column default (and anything else that names LAWYER) goes in a later migration. Existing
-- USER rows are moved by scripts/backfill-lawyer-role.ts, not here.
ALTER TYPE "Role" ADD VALUE 'LAWYER';
