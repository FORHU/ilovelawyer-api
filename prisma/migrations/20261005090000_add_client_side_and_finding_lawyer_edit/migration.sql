-- Which side the lawyer acts for, so the findings prompt can read "this case" as the client's case.
-- And when a lawyer last edited an AI finding, so a findings regeneration keeps it.

-- CreateEnum
CREATE TYPE "ClientSide" AS ENUM ('CLAIMANT', 'RESPONDENT');

-- AlterTable
ALTER TABLE "Case" ADD COLUMN "clientSide" "ClientSide";

-- AlterTable
ALTER TABLE "CaseFinding" ADD COLUMN "lawyerEditedAt" TIMESTAMP(3);
