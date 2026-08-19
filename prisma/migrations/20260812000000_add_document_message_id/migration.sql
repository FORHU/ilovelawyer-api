-- Links a Document to the single Message it was attached to on send, so an
-- attachment can be rendered as a chip on that specific message instead of
-- just floating at the consultation level. One-to-many (a Document is
-- attached to exactly one Message, never re-attached later), hence a nullable
-- FK column rather than a join table.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "messageId" TEXT;

-- CreateIndex
CREATE INDEX "Document_messageId_idx" ON "Document"("messageId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
