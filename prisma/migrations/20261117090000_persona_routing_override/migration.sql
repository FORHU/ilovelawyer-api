-- Replaces ModelSetting (Aug 2026), which was never consumed by chat-wonder-v2-api or
-- any admin UI, with PersonaRoutingOverride: persona-scoped, with AUTO/MANUAL as a real
-- routing state instead of always assuming a pinned model. CW-8, FORHU/ilovelawyer-api#663.

-- DropTable
DROP TABLE "ModelSetting";

-- CreateEnum
CREATE TYPE "RoutingMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateTable
CREATE TABLE "PersonaRoutingOverride" (
    "id" TEXT NOT NULL,
    "persona" TEXT NOT NULL,
    "routingMode" "RoutingMode" NOT NULL DEFAULT 'AUTO',
    "manualPinnedModel" TEXT,
    "toolOverrides" JSONB,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonaRoutingOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonaRoutingOverride_persona_key" ON "PersonaRoutingOverride"("persona");

-- CreateIndex
CREATE INDEX "PersonaRoutingOverride_updatedById_idx" ON "PersonaRoutingOverride"("updatedById");

-- AddForeignKey
ALTER TABLE "PersonaRoutingOverride" ADD CONSTRAINT "PersonaRoutingOverride_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
