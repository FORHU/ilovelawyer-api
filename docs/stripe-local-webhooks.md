# Stripe webhooks on your machine

The client app's payments (a new case, AI credit top-ups) can go through Stripe. When a client pays, Stripe tells the API with a **webhook**: a signed `POST` to `/api/webhooks/stripe`. Stripe can't reach `localhost`, so locally the **Stripe CLI** listens to your Stripe test account and forwards each webhook to your API.

This page sets that up in five steps, with no install beyond Docker. You only need it to work on payments. Everything else runs on the dummy provider, which charges nothing and needs no keys.

## What you need

- Docker (already used for Postgres, Redis and LocalStack).
- Access to the team's Stripe account in **test mode**. Ask whoever owns the Stripe account to invite you. Test mode charges nothing.
- The API running locally (`npm run dev`).

## Setup

### 1. Add the test keys to your `.env`

In the Stripe dashboard, switch on **Test mode** (top right), then go to **Developers → API keys**.

```env
CLIENT_PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
```

Only ever use `sk_test_` and `pk_test_` keys locally, never `sk_live_`. `.env` is gitignored, so keep keys out of every other file.

### 2. Get your webhook signing secret

```bash
npm run stripe:secret
```

This runs the Stripe CLI in Docker with your `STRIPE_SECRET_KEY` and prints a secret starting with `whsec_`. Add it to `.env`:

```env
STRIPE_WEBHOOK_SECRET=whsec_...
```

The secret stays the same for your key, so you only do this once.

### 3. Restart the API

The API reads `.env` only when it starts, and `npm run dev` doesn't restart on `.env` changes. Stop it and run `npm run dev` again.

### 4. Check the API takes webhooks

```bash
npm run stripe:webhook-check
```

This signs a test event with your secret and posts it to your API the way Stripe would. You should see five `PASS` lines and `All good`. It doesn't need Stripe, and it changes no payment. If something fails, the script prints the likely cause; see also [Troubleshooting](#troubleshooting).

### 5. Start forwarding

In a second terminal, and leave it running:

```bash
npm run stripe:listen
```

From now on, each webhook from your Stripe test account shows up in this terminal with the status your API answered (`[200]` is what you want), and it's handled by your local API.

## Paying in test mode

Use the client app (ilovelawyer-client) against your local API. Its Stripe payment form is FORHU/ilovelawyer-client#32. Pay for a case or a top-up with one of Stripe's test cards, with any future expiry date, any CVC and any postcode:

| Card number | What happens |
| --- | --- |
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0000 0000 0002` | Card declined |
| `4000 0025 0000 3155` | Asks for 3D Secure, then succeeds |

After a successful payment:
- the `stripe:listen` terminal shows `checkout.session.completed [200]`;
- the payment is `SUCCEEDED` in the database (`ClientPayment`), and in `GET /api/client/payments/:id`;
- for a case payment, the case can be created; for a top-up, the credits are on the case.

### Before the client app has the payment form

You can still check that Stripe's webhooks reach your API:

```bash
docker compose --profile stripe run --rm stripe-cli trigger checkout.session.completed
```

Stripe creates a test checkout and sends its events, and the `stripe:listen` terminal shows them arriving with `[200]`. The API acknowledges them and changes nothing, because the session isn't one of our payments. That's the same handling that keeps other environments' events from touching your data.

## How it works

- **The route.** `POST /api/webhooks/stripe` (`src/controllers/stripe-webhook.controller.ts`) is mounted in `src/app.ts` with the raw request body, **before** `express.json()`. Stripe signs the exact bytes it sends, so a parsed body would never match. Don't move it below the JSON parser.
- **Signatures.** Each call's `Stripe-Signature` is checked against `STRIPE_WEBHOOK_SECRET` (`src/payments/stripe-client.ts`). Forged, tampered or unsigned calls get a 400.
- **Events handled** (`ClientBillingSvc.handleStripeEvent`):
  - `checkout.session.completed` and `checkout.session.async_payment_succeeded` settle the payment as paid;
  - `checkout.session.async_payment_failed` and `checkout.session.expired` settle it as failed;
  - anything else is acknowledged and ignored.
- **Never applied twice.** Every handled event is recorded in `StripeWebhookEvent`, so a redelivery is answered without being applied again. Settling only moves a payment that is still `PENDING`, so the webhook and the app checking at the same moment can't add credits twice.
- **Sessions that aren't ours** (another environment or developer on the same Stripe account) are ignored.
- **The webhook isn't the only path.** `GET /api/client/payments/:id` asks Stripe directly and settles the payment if it has moved on. So a payment still completes if `stripe:listen` isn't running; the webhook makes it happen without the app having to ask.

## Troubleshooting

| What you see | Why, and the fix |
| --- | --- |
| `500 STRIPE_NOT_CONFIGURED` | The API started before the key or secret was in `.env`. Restart it. |
| `400` from `stripe:webhook-check`'s first check | Your `.env` and the running API disagree on `STRIPE_WEBHOOK_SECRET`. Restart the API after changing `.env`. |
| `404` | The API on that port doesn't have the webhook route (wrong branch, or not restarted). |
| `You have not configured API keys yet` from `stripe:secret` or `stripe:listen` | `STRIPE_SECRET_KEY` isn't in `.env`. Docker Compose reads it from there. |
| `stripe:listen` shows `connect: connection refused` | The API isn't running, or isn't on port 3001. Set `PORT` in `.env` if you use another. |
| On Linux, `stripe:listen` can't reach the API | The compose file maps `host.docker.internal` to your machine (`extra_hosts`). Make sure the API listens on `0.0.0.0` (it does by default), not only `127.0.0.1`. |
| Payments stay `PENDING` | `stripe:listen` isn't running. They still settle when the app polls `GET /api/client/payments/:id`, or when the 35-minute checkout expires. |
| `invalid_request_error` / `Invalid API Key` | The key is wrong, or it's from another Stripe account. |

## Deployed environments

These don't use the CLI. Each one has a webhook endpoint in the Stripe dashboard (**Developers → Webhooks → Add endpoint**) with the four `checkout.session.*` events above, and its own signing secret in GitHub.

| Environment | Endpoint URL | GitHub environment | Variables (var) and secrets (secret) |
| --- | --- | --- | --- |
| Dev | `https://uk-dev.ilovelawyer.com/api/webhooks/stripe` | `staging` | var `DEV_CLIENT_PAYMENT_PROVIDER`, secret `STRIPE_SECRET_KEY`, var `STRIPE_PUBLISHABLE_KEY`, secret `STRIPE_WEBHOOK_SECRET` |
| Staging | `https://api.ilovelawyer.com/api/webhooks/stripe` | `production` | var `CLIENT_PAYMENT_PROVIDER`, secret `STRIPE_SECRET_KEY`, var `STRIPE_PUBLISHABLE_KEY`, secret `STRIPE_WEBHOOK_SECRET` |
| UK | `https://uk.ilovelawyer.com/api/webhooks/stripe` | `production` | the same names, prefixed `UK_` |

UK's names are prefixed because `deploy-uk.yml` and staging read the same GitHub environment; without the prefix they would share one set of Stripe keys. Dev and staging use test-mode keys. UK uses live keys only once it takes real payments.

The webhook is under `/api` because the dev and UK hosts share a domain with a frontend and only send `/api/*` to the API.
