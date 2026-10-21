import crypto from "crypto";

/**
 * Takes the client app's payments (a new case, a credit top-up). There is one provider today, a
 * DUMMY that charges nothing. Stripe replaces it here later (with the lawyer billing in
 * ilovelawyer-api#505), and nothing else in ClientBillingSvc has to change: it only ever calls
 * charge() and stores what comes back.
 *
 * The client app never sends card details, so none reach this API, dummy or not.
 */
export interface ClientChargeRequest {
  userId: string;
  amountMinor: number;
  currency: string;
  description: string;
  /** "decline" asks the dummy to refuse, so the app's failure screen can be tested. A real provider
   * ignores it. */
  testOutcome?: "decline";
}

export type ClientChargeResult = { ok: true; externalId: string } | { ok: false; reason: string };

export interface ClientPaymentProvider {
  /** Stored on each ClientPayment, so a dummy payment is never mistaken for a real one. */
  readonly name: "DUMMY" | "STRIPE";
  charge(request: ClientChargeRequest): Promise<ClientChargeResult>;
}

export const dummyClientPaymentProvider: ClientPaymentProvider = {
  name: "DUMMY",
  async charge(request) {
    if (request.testOutcome === "decline") {
      return { ok: false, reason: "Your payment was declined by the bank. Try another method." };
    }
    return { ok: true, externalId: `dummy_${crypto.randomUUID()}` };
  },
};

let provider: ClientPaymentProvider = dummyClientPaymentProvider;

export function clientPaymentProvider(): ClientPaymentProvider {
  return provider;
}

/** Tests only. */
export function setClientPaymentProvider(next: ClientPaymentProvider): void {
  provider = next;
}
