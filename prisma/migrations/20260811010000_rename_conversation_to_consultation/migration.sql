-- The schema.prisma models Conversation/ConversationInvite/ConversationParticipant were renamed
-- to Consultation/ConsultationInvite/ConsultationParticipant (and Message.conversationId ->
-- consultationId) to match the UI, which has always called this feature "Consultation". This
-- brings the actual DB objects in line via RENAME, not drop/recreate, so existing rows and FKs
-- are preserved.

-- RenameTable
ALTER TABLE "Conversation" RENAME TO "Consultation";
ALTER TABLE "Consultation" RENAME CONSTRAINT "Conversation_pkey" TO "Consultation_pkey";
ALTER TABLE "ConversationInvite" RENAME TO "ConsultationInvite";
ALTER TABLE "ConsultationInvite" RENAME CONSTRAINT "ConversationInvite_pkey" TO "ConsultationInvite_pkey";
ALTER TABLE "ConversationParticipant" RENAME TO "ConsultationParticipant";
ALTER TABLE "ConsultationParticipant" RENAME CONSTRAINT "ConversationParticipant_pkey" TO "ConsultationParticipant_pkey";

-- RenameIndex (Consultation)
ALTER INDEX "Conversation_userId_idx" RENAME TO "Consultation_userId_idx";
ALTER INDEX "Conversation_caseId_idx" RENAME TO "Consultation_caseId_idx";

-- RenameForeignKey (Consultation)
ALTER TABLE "Consultation" RENAME CONSTRAINT "Conversation_userId_fkey" TO "Consultation_userId_fkey";
ALTER TABLE "Consultation" RENAME CONSTRAINT "Conversation_caseId_fkey" TO "Consultation_caseId_fkey";

-- RenameColumn + RenameIndex + RenameForeignKey (Message)
ALTER TABLE "Message" RENAME COLUMN "conversationId" TO "consultationId";
ALTER INDEX "Message_conversationId_idx" RENAME TO "Message_consultationId_idx";
ALTER TABLE "Message" RENAME CONSTRAINT "Message_conversationId_fkey" TO "Message_consultationId_fkey";

-- RenameColumn + RenameIndex + RenameForeignKey (ConsultationInvite)
ALTER TABLE "ConsultationInvite" RENAME COLUMN "conversationId" TO "consultationId";
ALTER INDEX "ConversationInvite_conversationId_idx" RENAME TO "ConsultationInvite_consultationId_idx";
ALTER TABLE "ConsultationInvite" RENAME CONSTRAINT "ConversationInvite_conversationId_fkey" TO "ConsultationInvite_consultationId_fkey";
ALTER TABLE "ConsultationInvite" RENAME CONSTRAINT "ConversationInvite_createdBy_fkey" TO "ConsultationInvite_createdBy_fkey";

-- RenameColumn + RenameForeignKey (ConsultationParticipant, conversationId is part of the composite PK)
ALTER TABLE "ConsultationParticipant" RENAME COLUMN "conversationId" TO "consultationId";
ALTER TABLE "ConsultationParticipant" RENAME CONSTRAINT "ConversationParticipant_conversationId_fkey" TO "ConsultationParticipant_consultationId_fkey";
ALTER TABLE "ConsultationParticipant" RENAME CONSTRAINT "ConversationParticipant_userId_fkey" TO "ConsultationParticipant_userId_fkey";
