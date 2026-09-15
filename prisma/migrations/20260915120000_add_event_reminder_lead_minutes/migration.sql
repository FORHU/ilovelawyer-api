-- Replace the fixed day-before/day-of reminder tracking with a single
-- user-configurable lead time (in minutes before the event).
ALTER TABLE "events" ADD COLUMN "reminder_lead_minutes" INTEGER;

ALTER TABLE "events" DROP COLUMN "reminder_day_before_sent_at";
ALTER TABLE "events" DROP COLUMN "reminder_day_of_sent_at";
