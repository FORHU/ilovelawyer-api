-- CreateEnum
CREATE TYPE "MessageReplyStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "pendingReplyContent" TEXT,
ADD COLUMN     "replyStatus" "MessageReplyStatus";

