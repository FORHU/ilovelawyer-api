-- Separate from otpCode/otpExpiry (password reset) so an in-flight reset request
-- and an in-flight email-verification OTP never overwrite each other.
ALTER TABLE "User" ADD COLUMN "emailVerificationOtp" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerificationOtpExpiry" TIMESTAMP(3);
