-- Consultation titles may be up to 80 characters (TITLE_MAX_CHARS).
ALTER TABLE "Consultation" ALTER COLUMN "title" SET DATA TYPE VARCHAR(80);
