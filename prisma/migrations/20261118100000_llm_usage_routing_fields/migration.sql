-- CW-9 (chat-wonder-v2-api#150): which routing_overrides.py mode was in effect and what
-- model_router.py decided, per LlmUsage row. Both nullable, plain strings (not an enum -- this
-- is ingested from chat-wonder-v2-api, an independently deployed service; an enum would reject
-- the whole row on any value drift between the two repos' deploys). Purely additive; existing
-- rows get null in both columns.

-- AlterTable
ALTER TABLE "LlmUsage" ADD COLUMN "routingMode" TEXT;
ALTER TABLE "LlmUsage" ADD COLUMN "decisionSource" TEXT;
