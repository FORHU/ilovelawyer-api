import type { Quotation as QuotationRow } from "@prisma/client";
import type { Quotation } from "../types/client-handoff";

const money = (amountMinor: number, currency: string) => ({ amountMinor, currency: currency as "GBP" });

/** Quotation in the contract, the same for the lawyer and the client. */
export function quotationDto(q: QuotationRow): Quotation {
  return {
    id: q.id,
    claimId: q.claimId,
    type: q.type,
    status: q.status,
    serviceFee: money(q.serviceFeeMinor, q.currency),
    platformFeeBps: q.platformFeeBps,
    platformFee: money(q.platformFeeMinor, q.currency),
    total: money(q.totalAmountMinor, q.currency),
    acceptedAmount: q.acceptedAmountMinor === null ? null : money(q.acceptedAmountMinor, q.currency),
    message: q.message,
    expiresAt: q.expiresAt.toISOString(),
    sentAt: q.sentAt?.toISOString() ?? null,
    acceptedAt: q.acceptedAt?.toISOString() ?? null,
    paidAt: q.paidAt?.toISOString() ?? null,
  };
}
