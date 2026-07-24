CREATE TABLE "MessageTimeline" (
  "id"        TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "items"     JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageTimeline_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageTimeline_messageId_key" ON "MessageTimeline"("messageId");

ALTER TABLE "MessageTimeline" ADD CONSTRAINT "MessageTimeline_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MessageMindMap" (
  "id"        TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "data"      JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageMindMap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageMindMap_messageId_key" ON "MessageMindMap"("messageId");

ALTER TABLE "MessageMindMap" ADD CONSTRAINT "MessageMindMap_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
