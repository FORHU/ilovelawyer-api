/** How long a self-requested account deletion stays cancellable before AccountDeletionQueue
 * hard-deletes the account for good. Signing in again during this window cancels it (see
 * AccountDeletionSvc.restoreOnSignIn). */
export const ACCOUNT_DELETION_GRACE_PERIOD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a deletion requested at `requestedAt` takes effect. */
export function accountDeletionDueAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + ACCOUNT_DELETION_GRACE_PERIOD_DAYS * DAY_MS);
}
