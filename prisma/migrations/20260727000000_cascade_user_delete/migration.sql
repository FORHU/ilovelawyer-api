-- Deleting a user must not be blocked by invites they created or conversations
-- they joined as a participant (as opposed to owned) elsewhere.
ALTER TABLE "ConversationInvite" DROP CONSTRAINT "ConversationInvite_createdBy_fkey";
ALTER TABLE "ConversationInvite" ADD CONSTRAINT "ConversationInvite_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationParticipant" DROP CONSTRAINT "ConversationParticipant_userId_fkey";
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
