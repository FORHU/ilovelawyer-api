CREATE TABLE "LegalSourceAnalysisCache" (
  "id"                TEXT NOT NULL,
  "rawKeyword"        TEXT NOT NULL,
  "normalizedKeyword" TEXT NOT NULL,
  "title"             TEXT NOT NULL,
  "markdownContent"   TEXT NOT NULL,
  "rawResponse"       TEXT NOT NULL,
  "sourceUrl"         TEXT,
  "metadataJson"      JSONB,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LegalSourceAnalysisCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegalSourceAnalysisCache_normalizedKeyword_key" ON "LegalSourceAnalysisCache"("normalizedKeyword");
