-- What lawyers pay in the UK hand-off, editable in admin per tenant (#598): the introduction fee and
-- the AI top-up packs, as PaymentPlan rows like the client app's prices.
-- AlterEnum
ALTER TYPE "PaymentPlanType" ADD VALUE IF NOT EXISTS 'LAWYER_INTRO_FEE';
ALTER TYPE "PaymentPlanType" ADD VALUE IF NOT EXISTS 'LAWYER_AI_TOP_UP';

-- AlterTable
ALTER TABLE "PaymentPlan" ADD COLUMN "creditMinor" INTEGER;
