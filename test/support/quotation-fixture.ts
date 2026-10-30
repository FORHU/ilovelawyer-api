import prisma from "../../src/lib/prisma";

/** A SENT quotation on a claim a test made straight in the database with its quote columns set, as
 * the lawyer app's send would leave it. No platform fee unless one is given. */
export async function sentQuotation(claim: { id: string; requestId: string; lawyerId: string }, serviceFeeMinor = 75000, platformFeeMinor = 0) {
  return prisma.quotation.create({
    data: {
      claimId: claim.id,
      requestId: claim.requestId,
      lawyerId: claim.lawyerId,
      type: "FIXED_FEE",
      serviceFeeMinor,
      platformFeeBps: 0,
      platformFeeMinor,
      totalAmountMinor: serviceFeeMinor + platformFeeMinor,
      message: "Fixed fee.",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: "SENT",
      sentAt: new Date(),
    },
  });
}

/** Removes the payments, earnings and wallets a test's engagements left behind: none of them has a
 * foreign key to the people or firms the test deletes. */
export async function cleanQuotationMoney(owners: { organizationIds?: string[]; userIds?: string[] }, clientIds: string[]) {
  const wallets = await prisma.wallet.findMany({
    where: { OR: [{ ownerType: "ORGANIZATION", ownerId: { in: owners.organizationIds ?? [] } }, { ownerType: "USER", ownerId: { in: owners.userIds ?? [] } }] },
    select: { id: true },
  });
  const walletIds = wallets.map((w) => w.id);
  await prisma.walletLedgerEntry.deleteMany({ where: { walletId: { in: walletIds } } });
  await prisma.earning.deleteMany({ where: { walletId: { in: walletIds } } });
  await prisma.withdrawal.deleteMany({ where: { walletId: { in: walletIds } } });
  await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
  await prisma.quotationPayment.deleteMany({ where: { clientId: { in: clientIds } } });
}
