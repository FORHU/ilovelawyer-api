-- AlterEnum
ALTER TYPE "PaymentPlanType" ADD VALUE IF NOT EXISTS 'B2C_TOP_UP';

-- AlterTable
ALTER TABLE "PaymentPlan" ADD COLUMN     "credits" INTEGER,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceMinor" INTEGER;

-- CreateTable
CREATE TABLE "ClientPromo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "discountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "firstCaseOnly" BOOLEAN NOT NULL DEFAULT false,
    "oncePerClient" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ClientPromo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientPromo_updatedById_idx" ON "ClientPromo"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "ClientPromo_tenantId_code_key" ON "ClientPromo"("tenantId", "code");

-- CreateIndex
CREATE INDEX "ClientPayment_promoCode_status_idx" ON "ClientPayment"("promoCode", "status");

-- AddForeignKey
ALTER TABLE "ClientPromo" ADD CONSTRAINT "ClientPromo_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPromo" ADD CONSTRAINT "ClientPromo_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

