-- The client's note on a document they added (the evidence step): drafted by the AI once the
-- document is read, until the client writes their own. Sealed with the intake key.

-- CreateEnum
CREATE TYPE "DocumentNoteAuthor" AS ENUM ('AI', 'CLIENT');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "clientNote" TEXT,
ADD COLUMN "clientNoteBy" "DocumentNoteAuthor";
