-- Per-sentence start times for a rendered Audio Overview, from Polly's sentence speech marks
-- (see sentenceTimingsForTurn in audio-overview-render.ts) — used to highlight the sentence
-- being spoken as it plays.
ALTER TABLE "MessageAudioOverview" ADD COLUMN "sentenceTimings" JSONB;
