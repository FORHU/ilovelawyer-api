export const BCRYPT_SALT_ROUNDS = 10;
export const OTP_EXPIRY_MS = 60 * 60 * 1000; // 1 hour — password-reset token

// Signup email verification — shorter-lived than the password-reset token above
// since it's meant to be entered immediately in the same browser session.
export const EMAIL_VERIFICATION_CODE_LENGTH = 6;
export const EMAIL_VERIFICATION_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds
export const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
