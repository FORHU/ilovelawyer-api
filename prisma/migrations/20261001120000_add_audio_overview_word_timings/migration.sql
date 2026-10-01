-- Per-word start times for a rendered Audio Overview, from Polly's word speech marks (see
-- markTimingsForTurn in audio-overview-render.ts) — used to fill the active turn in word by
-- word as it plays.
ALTER TABLE "MessageAudioOverview" ADD COLUMN "wordTimings" JSONB;
