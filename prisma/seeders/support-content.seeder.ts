import SupportContentSvc from "../../src/services/support-content.service";

// Publishes version 1 of the Support Chat's content when there isn't one yet. The first read does
// the same, so a database that never ran the seed still works. Create-only: published content an
// admin has since changed is left as it is.
export async function seedSupportContent() {
  await SupportContentSvc.ensureSeeded();
}
