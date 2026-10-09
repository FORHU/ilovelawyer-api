export const BCRYPT_SALT_ROUNDS = 10;
export const OTP_EXPIRY_MS = 60 * 60 * 1000; // 1 hour — password-reset token

// Signup email verification — shorter-lived than the password-reset token above
// since it's meant to be entered immediately in the same browser session.
export const EMAIL_VERIFICATION_CODE_LENGTH = 6;
export const EMAIL_VERIFICATION_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds
export const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;

// Login-link token sent in the admin-approval email — longer-lived than the password-reset
// token since approval isn't something the user is actively waiting on the way a reset is.
export const LOGIN_LINK_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Stamped on User.termsVersion when a signup (password or first-time Google) accepts the
// Terms of Service. Bump this whenever the Terms text in ilovelawyer-app's
// locales/*/term.json materially changes, so a later re-acceptance prompt can tell which
// version each account agreed to.
export const TERMS_VERSION = "2026-10";

// How many times createGoogleUser retries a username collision (Prisma P2002 on `username`)
// with a fresh numeric suffix before giving up.
export const GOOGLE_USERNAME_MAX_ATTEMPTS = 5;

// Avatar images (upload, and the Google profile photo copied at Google signup): JPEG, PNG or
// WebP up to this size. The Google copy is requested at GOOGLE_PHOTO_SIZE_PX square.
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const GOOGLE_PHOTO_SIZE_PX = 256;
export const GOOGLE_PHOTO_FETCH_TIMEOUT_MS = 5_000;

// How long a Google signup waits for the profile-photo copy before responding, so the new
// user's first screen already shows it. Longer than this, it finishes in the background.
export const GOOGLE_PHOTO_SIGNUP_WAIT_MS = 3_000;

// Length of the Google Calendar copy of an appointment that has no end time.
export const GOOGLE_CALENDAR_DEFAULT_EVENT_MINUTES = 60;

// Two-way Google Calendar sync (GoogleCalendarSyncQueue / GoogleCalendarPullSvc): how often each
// connected user's calendar is checked for changes, and the most pages (250 events each) one
// check reads before continuing on the next poll.
export const GOOGLE_CALENDAR_POLL_INTERVAL_MS = 2 * 60 * 1000;
export const GOOGLE_CALENDAR_PULL_MAX_PAGES = 20;
