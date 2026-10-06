/** How long a consultation's requested deletion stays cancellable (by restoring it from the
 * archive) before ConsultationDeletionQueue purges it for good — same window as an account's
 * (ACCOUNT_DELETION_GRACE_PERIOD_DAYS). */
export const CONSULTATION_DELETION_GRACE_PERIOD_DAYS = 30;

/** When a deletion requested at `requestedAt` takes effect. */
export function consultationDeletionDueAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + CONSULTATION_DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}
