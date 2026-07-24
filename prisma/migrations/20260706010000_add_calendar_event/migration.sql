CREATE TABLE "CalendarWatchChannel" (
  "id"         TEXT NOT NULL,
  "channelId"  TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "expiration" BIGINT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalendarWatchChannel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CalendarWatchChannel_channelId_key" ON "CalendarWatchChannel"("channelId");

ALTER TABLE "CalendarWatchChannel" ADD CONSTRAINT "CalendarWatchChannel_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "events" (
  "id"                         TEXT NOT NULL,
  "userId"                     TEXT NOT NULL,
  "title"                      TEXT NOT NULL,
  "type"                       TEXT NOT NULL DEFAULT 'Meeting',
  "date_time"                  TIMESTAMP(3) NOT NULL,
  "client_email"               TEXT,
  "notes"                      TEXT,
  "status"                     TEXT NOT NULL DEFAULT 'pending',
  "google_link"                TEXT,
  "google_event_id"            TEXT,
  "last_reminder_sent_at"      TIMESTAMP(3),
  "reminder_day_before_sent_at" TIMESTAMP(3),
  "reminder_day_of_sent_at"    TIMESTAMP(3),
  "lawyer_acknowledged_at"     TIMESTAMP(3),
  "client_feedback"            TEXT,
  "created_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "events_google_event_id_user_id_key" ON "events"("google_event_id", "userId");
CREATE INDEX "events_userId_idx" ON "events"("userId");

ALTER TABLE "events" ADD CONSTRAINT "events_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
