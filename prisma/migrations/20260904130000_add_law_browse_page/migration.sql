-- Additive: brand-new table, no touch to any existing table.

-- CreateTable
CREATE TABLE "LawBrowsePage" (
    "id" TEXT NOT NULL,
    "pageKey" TEXT NOT NULL,
    "filterKey" TEXT NOT NULL,
    "isFirstPage" BOOLEAN NOT NULL,
    "jurisIds" TEXT[],
    "hasMore" BOOLEAN NOT NULL,
    "nextCursor" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LawBrowsePage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LawBrowsePage_pageKey_key" ON "LawBrowsePage"("pageKey");
