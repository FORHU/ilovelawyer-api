-- CreateTable
CREATE TABLE "ScreenPreset" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "labelKey" TEXT,
    "descriptionKey" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "screenCount" INTEGER NOT NULL,
    "screens" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreenPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScreenPreset_userId_idx" ON "ScreenPreset"("userId");

-- CreateIndex
CREATE INDEX "ScreenPreset_screenCount_idx" ON "ScreenPreset"("screenCount");

-- AddForeignKey
ALTER TABLE "ScreenPreset" ADD CONSTRAINT "ScreenPreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
