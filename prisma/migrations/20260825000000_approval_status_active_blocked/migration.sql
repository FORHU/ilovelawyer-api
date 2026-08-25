-- Rename APPROVED -> ACTIVE and add BLOCKED, per the state machine in schema.prisma's
-- ApprovalStatus comment. The column default is already 'PENDING' (unaffected by this
-- rename) — see 20260824090000_add_user_approval_status.
ALTER TYPE "ApprovalStatus" RENAME VALUE 'APPROVED' TO 'ACTIVE';
ALTER TYPE "ApprovalStatus" ADD VALUE 'BLOCKED';
