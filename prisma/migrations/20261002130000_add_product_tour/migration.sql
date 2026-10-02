-- CreateEnum
CREATE TYPE "ProductTourStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED');

-- CreateTable
CREATE TABLE "ProductTour" (
    "userId" TEXT NOT NULL,
    "track" TEXT NOT NULL DEFAULT 'main',
    "status" "ProductTourStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "archetype" TEXT,
    "currentStep" TEXT,
    "doneSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductTour_pkey" PRIMARY KEY ("userId","track")
);

-- AddForeignKey
ALTER TABLE "ProductTour" ADD CONSTRAINT "ProductTour_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

