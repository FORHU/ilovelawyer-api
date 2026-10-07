-- Personal workspaces: the private org a user gets when they skip workspace onboarding.
-- Every existing org was created deliberately (solo / create / join), so all default to false.
ALTER TABLE "Organization" ADD COLUMN "isPersonal" BOOLEAN NOT NULL DEFAULT false;
