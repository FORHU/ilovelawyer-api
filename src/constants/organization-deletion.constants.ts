/** How long an organization its last member left stays archived (PENDING_DELETION) before
 * OrganizationDeletionQueue deletes it for good — same window as an account's
 * (ACCOUNT_DELETION_GRACE_PERIOD_DAYS). Restoring within it is done by customer support. */
export const ORGANIZATION_DELETION_GRACE_PERIOD_DAYS = 30;

/** When an organization archived at `archivedAt` is deleted. */
export function organizationDeletionDueAt(archivedAt: Date): Date {
  return new Date(archivedAt.getTime() + ORGANIZATION_DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}
