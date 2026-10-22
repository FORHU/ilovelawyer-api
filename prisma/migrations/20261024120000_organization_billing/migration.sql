-- An organization's card on file for the client hand-off's per-case fee (ilovelawyer-api#505).
-- CreateTable
CREATE TABLE "OrganizationBilling" (
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "customerId" TEXT,
    "paymentMethodId" TEXT,
    "brand" TEXT,
    "last4" TEXT,
    "expMonth" INTEGER,
    "expYear" INTEGER,
    "setupSessionId" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationBilling_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationBilling_customerId_key" ON "OrganizationBilling"("customerId");

-- AddForeignKey
ALTER TABLE "OrganizationBilling" ADD CONSTRAINT "OrganizationBilling_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
