-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "urgentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "urgent" BOOLEAN,
ADD COLUMN     "urgencyProbability" DOUBLE PRECISION;
