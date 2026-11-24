-- Separate consent for sensitive information before the AI reads a client's case (ilovelawyer-api#699).
-- AlterEnum
ALTER TYPE "ConsentPurpose" ADD VALUE 'SENSITIVE_INFO';
