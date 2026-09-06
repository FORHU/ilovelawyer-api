// A crashed server never reaches `finish`, which would otherwise leave a lock stuck IN_PROGRESS
// forever. Past this age, a lock is treated as abandoned and silently reclaimed rather than
// blocking every future attempt.
export const STALE_AFTER_MS = 10 * 60 * 1000;
