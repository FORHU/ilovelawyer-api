-- AlterTable
ALTER TABLE "User" ADD COLUMN "googleCalendarSyncToken" TEXT;

-- AlterTable
ALTER TABLE "events" ADD COLUMN "google_updated_at" TIMESTAMP(3),
ADD COLUMN "google_dirty_at" TIMESTAMP(3);
