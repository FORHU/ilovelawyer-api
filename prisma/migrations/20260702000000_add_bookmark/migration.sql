CREATE TYPE "BookmarkType" AS ENUM ('case', 'source');

CREATE TABLE "Bookmark" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "itemId"    TEXT NOT NULL,
  "title"     TEXT NOT NULL,
  "reference" TEXT,
  "type"      "BookmarkType" NOT NULL,
  "url"       TEXT,
  "aiSummary" TEXT,
  "doctrine"  TEXT,
  "facts"     TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Bookmark_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Bookmark_userId_itemId_key" ON "Bookmark"("userId", "itemId");
CREATE INDEX "Bookmark_userId_idx" ON "Bookmark"("userId");

ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
