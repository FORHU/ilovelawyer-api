-- The AI credit an AI_TOP_UP charge adds to its engagement's budget (#516). Null on per-case fees.
ALTER TABLE "OrganizationCharge" ADD COLUMN "creditMinor" INTEGER;
