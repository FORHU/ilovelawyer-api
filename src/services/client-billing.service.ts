import ClientPaymentRepo from "../repositories/client-payment.repository";
import { clientPaymentProvider } from "../payments/client-payment-provider";
import HttpError from "../utils/http-error";
import {
  CLIENT_CASE_CREDITS,
  CLIENT_CASE_PRICE_MINOR,
  CLIENT_CURRENCY,
  CLIENT_DEFAULT_TOP_UP_PACK,
  CLIENT_PROMOS,
  CLIENT_TOP_UP_PACKS,
} from "../constants/client-pricing.constants";

const money = (amountMinor: number) => ({ amountMinor, currency: CLIENT_CURRENCY });

type TestOutcome = "decline" | undefined;

/**
 * Paying for the client app: one payment per new case, and credit top-ups on a case. Chat credits
 * live on the case (Case.clientCredits), and each message to the AI takes one (spendCredit).
 *
 * Every payment goes through clientPaymentProvider(), a dummy for now (see
 * payments/client-payment-provider.ts), and is stored as a ClientPayment, declined ones included.
 */
export default class ClientBillingSvc {
  static pricing() {
    return {
      case: { price: money(CLIENT_CASE_PRICE_MINOR), credits: CLIENT_CASE_CREDITS },
      topUpPacks: CLIENT_TOP_UP_PACKS.map((p) => ({ id: p.id, name: p.name, credits: p.credits, price: money(p.priceMinor) })),
      defaultPackId: CLIENT_DEFAULT_TOP_UP_PACK,
    };
  }

  /** What a new case costs this client, with a promo code applied if it can be. */
  static async quoteCase(userId: string, promoCode?: string) {
    const price = CLIENT_CASE_PRICE_MINOR;
    const quote = (discountMinor: number, promo: { code: string; applied: boolean; message: string } | null) => ({
      price: money(price),
      discount: money(discountMinor),
      total: money(price - discountMinor),
      promo,
    });
    const code = promoCode?.trim();
    if (!code) return quote(0, null);

    const promo = CLIENT_PROMOS.find((p) => p.code.toLowerCase() === code.toLowerCase());
    if (!promo) return quote(0, { code, applied: false, message: "That code isn't valid." });
    if (promo.firstCaseOnly && (await ClientPaymentRepo.hasPaidForCase(userId))) {
      return quote(0, { code: promo.code, applied: false, message: `${promo.code} only applies to your first case.` });
    }
    return quote(Math.min(promo.discountMinor, price), { code: promo.code, applied: true, message: `${promo.code} applied: ${promo.description}.` });
  }

  /** Pays for a new case. The payment is then used up creating it (ClientCaseSvc.create). A code
   * that doesn't apply is refused rather than silently charging the full price. */
  static async payForCase(userId: string, input: { promoCode?: string; testOutcome?: TestOutcome }) {
    const quote = await ClientBillingSvc.quoteCase(userId, input.promoCode);
    if (quote.promo && !quote.promo.applied) throw new HttpError(quote.promo.message, 400, "PROMO_NOT_APPLIED");
    const payment = await ClientBillingSvc.charge(userId, {
      kind: "CASE",
      caseId: null,
      amountMinor: quote.total.amountMinor,
      credits: CLIENT_CASE_CREDITS,
      promoCode: quote.promo?.code ?? null,
      description: "New case",
      testOutcome: input.testOutcome,
    });
    return { paymentId: payment.id, amount: money(payment.amountMinor), credits: payment.credits };
  }

  /** The caller has already checked the case is this client's. */
  static async topUp(userId: string, caseId: string, input: { packId: string; testOutcome?: TestOutcome }) {
    const pack = CLIENT_TOP_UP_PACKS.find((p) => p.id === input.packId);
    if (!pack) throw new HttpError("No such top-up pack", 400);
    await ClientBillingSvc.charge(userId, {
      kind: "TOP_UP",
      caseId,
      amountMinor: pack.priceMinor,
      credits: pack.credits,
      promoCode: null,
      description: `${pack.credits} chat credits`,
      testOutcome: input.testOutcome,
    });
    const credits = await ClientPaymentRepo.addCredits(caseId, pack.credits);
    return { credits, added: pack.credits, amount: money(pack.priceMinor) };
  }

  /** Takes one credit for a message to the AI. 402 OUT_OF_CREDITS when there are none. */
  static async spendCredit(caseId: string) {
    if (!(await ClientPaymentRepo.spendCredit(caseId))) {
      throw new HttpError("You're out of chat credits for this case. Top up to keep going.", 402, "OUT_OF_CREDITS");
    }
  }

  /** Gives back the credit of a message the AI never took (it couldn't be queued). */
  static async refundCredit(caseId: string) {
    await ClientPaymentRepo.addCredits(caseId, 1);
  }

  private static async charge(
    userId: string,
    p: {
      kind: "CASE" | "TOP_UP";
      caseId: string | null;
      amountMinor: number;
      credits: number;
      promoCode: string | null;
      description: string;
      testOutcome: TestOutcome;
    },
  ) {
    const provider = clientPaymentProvider();
    const result = await provider.charge({
      userId,
      amountMinor: p.amountMinor,
      currency: CLIENT_CURRENCY,
      description: p.description,
      testOutcome: p.testOutcome,
    });
    const payment = await ClientPaymentRepo.create({
      userId,
      caseId: p.caseId,
      kind: p.kind,
      provider: provider.name,
      externalId: result.ok ? result.externalId : null,
      amountMinor: p.amountMinor,
      currency: CLIENT_CURRENCY,
      credits: p.credits,
      promoCode: p.promoCode,
      status: result.ok ? "SUCCEEDED" : "FAILED",
      failureReason: result.ok ? null : result.reason,
    });
    if (!result.ok) throw new HttpError(result.reason, 402, "PAYMENT_DECLINED");
    return payment;
  }
}
