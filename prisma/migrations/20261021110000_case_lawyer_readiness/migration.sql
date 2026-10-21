-- Client app: Jev's last check of whether a case has enough in it to suggest a lawyer.
ALTER TABLE "Case" ADD COLUMN "lawyerReadiness" JSONB;
