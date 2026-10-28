/**
 * Staff only. Case payments a client paid for but never used to create a case: money taken, nothing
 * to show for it, now that cases are free (ADR 0019). Each needs refunding by an admin from the
 * admin app's Billing page (POST /api/admin/billing/:id/refund). Run once before and after shipping
 * free cases:
 *
 *   npx ts-node --files scripts/report-unused-case-payments.ts
 *
 * Only STRIPE payments took money (DUMMY and FREE didn't, so they're listed but not refundable).
 * Read-only.
 */
import prisma from "../src/lib/prisma";

async function main() {
  const payments = await prisma.clientPayment.findMany({
    where: { kind: "CASE", status: "SUCCEEDED", usedAt: null },
    select: {
      id: true,
      provider: true,
      amountMinor: true,
      currency: true,
      createdAt: true,
      user: { select: { email: true } },
      refunds: { where: { status: { in: ["PENDING", "SUCCEEDED"] } }, select: { amountMinor: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const rows = payments.map((p) => {
    const refunded = p.refunds.reduce((sum, r) => sum + r.amountMinor, 0);
    return { ...p, owed: p.provider === "STRIPE" ? p.amountMinor - refunded : 0 };
  });
  const toRefund = rows.filter((r) => r.owed > 0);

  for (const r of rows) {
    const note = r.provider !== "STRIPE" ? `${r.provider}, no money taken` : r.owed > 0 ? `refund ${r.owed} ${r.currency}` : "already refunded";
    console.log(`${r.id}  ${r.createdAt.toISOString().slice(0, 10)}  ${r.user.email}  ${r.amountMinor} ${r.currency}  ${note}`);
  }
  console.log(`\n${rows.length} unused case payment(s), ${toRefund.length} still to refund.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
