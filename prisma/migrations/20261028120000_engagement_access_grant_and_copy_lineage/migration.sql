-- The engaged lawyer's workspace copy of a client's case (ilovelawyer-api#514), and the engagement
-- a queued copy was made for.
-- AlterTable
ALTER TABLE "ClientRequest" ADD COLUMN     "copyCaseId" TEXT;

-- AlterTable
ALTER TABLE "CaseCopy" ADD COLUMN     "requestId" TEXT;
