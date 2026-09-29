-- Per-turn start-second timings for a rendered Audio Overview (see turnStartTimes in
-- audio-overview-render.ts) — used to highlight/auto-scroll the current turn as it plays.
ALTER TABLE "MessageAudioOverview" ADD COLUMN "turnTimings" JSONB;
