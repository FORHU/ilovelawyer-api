/**
 * Checks that the local API takes Stripe webhooks correctly, without needing Stripe: signs a test
 * event with STRIPE_WEBHOOK_SECRET from .env and posts it to /api/webhooks/stripe, the same way
 * Stripe would. Proves the route is mounted with a raw body, the secret matches, redeliveries are
 * recognised, and forged calls are refused. Run while the API is up (npm run dev):
 *
 *   npm run stripe:webhook-check
 *
 * The test event names a session that doesn't exist, so it changes no payment. It does leave one
 * StripeWebhookEvent row (evt_local_check_...), which is harmless.
 */
import * as dotenv from "dotenv";
dotenv.config();
import Stripe from "stripe";

const API = process.env.WEBHOOK_CHECK_URL || `http://localhost:${process.env.PORT || 3001}/api/webhooks/stripe`;
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;

interface Check {
  name: string;
  expectStatus: number;
  expectBody?: string;
  payload: string;
  signature: string;
}

async function post(payload: string, signature: string) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "Stripe-Signature": signature } : {}) },
    body: payload,
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  if (!SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET isn't set in .env. See docs/stripe-local-webhooks.md, step 2.");
    process.exitCode = 1;
    return;
  }
  const payload = JSON.stringify({
    id: `evt_local_check_${Date.now()}`,
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_local_check", object: "checkout.session", status: "complete", payment_status: "paid", metadata: {} } },
  });
  const sign = (body: string, secret: string) => Stripe.webhooks.generateTestHeaderString({ payload: body, secret });

  const checks: Check[] = [
    { name: "A correctly signed event is accepted", expectStatus: 200, expectBody: '"duplicate":false', payload, signature: sign(payload, SECRET) },
    { name: "The same event again is recognised as a redelivery", expectStatus: 200, expectBody: '"duplicate":true', payload, signature: sign(payload, SECRET) },
    { name: "An event signed with another secret is refused", expectStatus: 400, payload, signature: sign(payload, "whsec_not_ours") },
    { name: "A tampered body is refused", expectStatus: 400, payload: payload.replace("cs_test_local_check", "cs_test_tampered"), signature: sign(payload, SECRET) },
    { name: "A call with no signature is refused", expectStatus: 400, payload, signature: "" },
  ];

  console.log(`Posting to ${API}\n`);
  let failed = 0;
  for (const check of checks) {
    let result: { status: number; body: string };
    try {
      result = await post(check.payload, check.signature);
    } catch (err) {
      console.error(`Couldn't reach the API at ${API}. Is it running (npm run dev)?`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
      return;
    }
    const ok = result.status === check.expectStatus && (!check.expectBody || result.body.includes(check.expectBody));
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${check.name}  (got ${result.status} ${result.body.slice(0, 120)})`);
  }

  if (failed) {
    console.log(`\n${failed} check(s) failed.`);
    console.log("A 500 STRIPE_NOT_CONFIGURED means the API was started before STRIPE_WEBHOOK_SECRET was in .env: restart it.");
    console.log("A 400 on the first check means .env and the API disagree on the secret: restart the API after changing .env.");
    console.log("A 404 means the API on this port doesn't have the webhook route yet (wrong branch, or not restarted).");
    // exitCode, not exit(): exiting with fetch's connections still open crashes Node on Windows.
    process.exitCode = 1;
    return;
  }
  console.log("\nAll good: this API takes Stripe webhooks with your secret.");
}

main();
