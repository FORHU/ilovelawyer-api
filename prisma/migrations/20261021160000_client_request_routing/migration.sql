-- Routing (#509): when the 48h unclaimed window ends, and which lawyers are excluded from
-- matching this request again after they passed, released or lapsed on it.
-- AlterTable
ALTER TABLE "ClientRequest" ADD COLUMN     "routingExpiresAt" TIMESTAMP(3),
ADD COLUMN     "excludedLawyerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
