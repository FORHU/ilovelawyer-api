-- AlterTable
ALTER TABLE "Witness" ADD COLUMN     "aiCredibility" INTEGER,
ADD COLUMN     "aiRationale" JSONB,
ADD COLUMN     "aiSuggestedStatus" "WitnessStatus",
ADD COLUMN     "credibilityOverride" INTEGER,
ADD COLUMN     "scoredAt" TIMESTAMP(3),
ADD COLUMN     "statementDueOn" TIMESTAMP(3),
ADD COLUMN     "statementReceived" BOOLEAN NOT NULL DEFAULT false;
