# Stripe on your machine

Every payment in the API runs on a **dummy provider** by default: it charges nothing, settles at once and needs no keys. You only need this page to work on payments for real, in Stripe's **test mode**.

When something is paid, Stripe tells the API with a **webhook**: a signed `POST` to the API. Stripe can't reach `localhost`, so on your machine the **Stripe CLI** (run in Docker) listens to the team's Stripe test account and forwards each webhook to your API.

## What goes through Stripe

Each flow has its own switch in `.env`. Turn on only the ones you're working on; the rest stay dummy.

| Flow | Switch in `.env` | What it uses in Stripe |
| --- | --- | --- |
| Client app: chat credit top-ups | `CLIENT_PAYMENT_PROVIDER=stripe` | Checkout, embedded in the client app |
| Lawyer app: a firm's or solo lawyer's card on file | `LAWYER_PAYMENT_PROVIDER=stripe` | Checkout in setup mode, then off-session charges |
| Client app: paying a lawyer's quote | `QUOTATION_PAYMENT_PROVIDER=stripe` | PaymentIntent and the Payment Element |
| Lawyer app: withdrawing earnings to a bank | `PAYOUT_PROVIDER=stripe` | Connect Express accounts, transfers and payouts |
| Lawyer app: AI top-ups and subscription plans | always Stripe | Checkout (payment and subscription modes) |

Subscription plans need no setup in the Stripe dashboard: the API creates each plan's Product and Price the first time someone checks out.

## Before you start

Once per developer:

- **Docker Desktop** and **Node.js** installed.
- **The API running on the dummy providers first.** Clone `ilovelawyer-api`, then:
  ```bash
  npm install
  cp .env.example .env        # then fill in what the team gives you
  docker compose up -d        # Postgres, Redis, LocalStack
  npx prisma migrate dev
  npm run dev                 # the API, on port 3001
  ```
- **Access to the team's Stripe account in test mode.** Ask whoever owns the Stripe account to invite you, then copy the keys from the dashboard yourself. Test mode charges nothing. Keys go in your `.env` only, which is gitignored. Never put them in chat, a commit or another file.
- **For payouts only:** Connect must be turned on in the account's test mode (**Dashboard → Connect**). That's done once per Stripe account, by its owner. Without it, setting up payouts fails.

## Setup

Once per machine. Commands are for a terminal in `ilovelawyer-api` (Git Bash on Windows).

### 1. Add the test keys and switch the flows on

In the Stripe dashboard, switch on **Test mode** (top right), then go to **Developers → API keys**. In `.env`:

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...

# Only the flows you're working on:
CLIENT_PAYMENT_PROVIDER=stripe
LAWYER_PAYMENT_PROVIDER=stripe
QUOTATION_PAYMENT_PROVIDER=stripe
PAYOUT_PROVIDER=stripe
```

Only ever use `sk_test_` and `pk_test_` keys locally, never `sk_live_`. The frontends need no Stripe keys: the API hands them the publishable key with each payment.

### 2. Get your webhook signing secret

```bash
npm run stripe:secret
```

This runs the Stripe CLI in Docker with your `STRIPE_SECRET_KEY` and prints a secret starting with `whsec_`. Put it in **both** webhook variables:

```env
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
```

They're the same locally because the CLI signs both endpoints with one secret. Deployed, they're two different endpoints with two secrets.

Get your own secret on each machine rather than copying a teammate's. It stays the same for your key, so you only do this once.

### 3. Restart the API

The API reads `.env` only when it starts, and `npm run dev` doesn't restart on `.env` changes. Stop it and run `npm run dev` again. Do this after every `.env` change.

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

It forwards the platform's events to `/api/webhooks/stripe` and lawyers' connected accounts' events (payouts) to `/api/webhooks/stripe-connect`. Each webhook shows up in this terminal with the status your API answered; `[200]` is what you want.

To see it work without the apps, in a third terminal:

```bash
docker compose --profile stripe run --rm stripe-cli trigger checkout.session.completed
```

The listener shows the events arriving with `[200]`. The API acknowledges them and changes nothing, because the session isn't one of your payments.

## Each time you work on payments

| Terminal | Command | Why |
| --- | --- | --- |
| any | `docker compose up -d` | Postgres, Redis and LocalStack |
| 1 | `npm run dev` | The API |
| 2 | `npm run stripe:listen` | Stripe's webhooks to your API |
| 3, 4 | the client app and the lawyer app | To pay and to be paid |

Without the listener, most payments still finish when the app checks their status, but subscription renewals and payout results never arrive.

## Sharing the test account with other developers

The whole team uses one Stripe test account, so everyone's test data lands in the same place. That's expected, and it's safe:

- **You see your teammates' events.** Every developer's listener receives every event in the account. Yours shows them with `[200]`, and your API ignores them, because the payment isn't in your database. The deployed dev environment uses the same account and ignores yours the same way.
- **Stripe data is shared, databases aren't.** Each developer's database creates its own customers, connected accounts and plan Products and Prices in the account. Expect duplicates named after the same plans, and don't archive or delete objects you didn't make.
- **Find your own payments by id.** The payment id is in your database (e.g. `QuotationPayment.paymentIntentId`). Search for it in the dashboard rather than browsing the lists.
- **Don't roll the shared keys.** Rolling `sk_test_` in the dashboard breaks every teammate's `.env` and listener until they update it. If it has to happen, tell the team first.

## Testing each flow

Pay with Stripe's test cards, with any future expiry date, any CVC and any postcode:

| Card number | What happens |
| --- | --- |
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0000 0000 0002` | Card declined |
| `4000 0025 0000 3155` | Asks for 3D Secure, then succeeds |
| `4000 0000 0000 0077` | Succeeds, and the money is available at once (use it before testing withdrawals) |

| Flow | Where | What you should see |
| --- | --- | --- |
| Chat credit top-up | Client app, a case, top up | `checkout.session.completed [200]`; `ClientPayment` is `SUCCEEDED`; the credits are on the case |
| Card on file | Lawyer app, Organization (or profile), payment card | `checkout.session.completed [200]`; the card's brand and last 4 show |
| Paying a quote | Client app, a lawyer's quote, accept and pay | `payment_intent.succeeded [200]`; the request is `ENGAGED`; the lawyer's earning is on hold |
| Withdrawing | Lawyer app, Earnings | `payout.paid [200]` on the connect endpoint; the withdrawal is `PAID` |

To test a withdrawal without waiting a week:

1. Pay a quote with `4000 0000 0000 0077`.
2. In the admin app, set the tenant's **earnings hold** to 0 days (Payout Settings). The sweep then makes the earning available within a minute.
3. In the lawyer app, set up payouts. Stripe's test-mode onboarding accepts test values: verification code `000000`, sort code `10-88-00`, account number `00012345`.
4. Withdraw at least the minimum (£10 by default).

Set the hold back afterwards if other developers rely on your database's settings.

## Running the API tests

The tests expect the dummy providers. If your `.env` switches any flow to Stripe, override them for the run, or a dozen payment tests fail:

```bash
QUOTATION_PAYMENT_PROVIDER=dummy PAYOUT_PROVIDER=dummy LAWYER_PAYMENT_PROVIDER=dummy CLIENT_PAYMENT_PROVIDER=dummy npm test
```

## How it works

- **Two routes.** `POST /api/webhooks/stripe` takes the platform's events, signed with `STRIPE_WEBHOOK_SECRET`. `POST /api/webhooks/stripe-connect` takes events on lawyers' connected accounts, signed with `STRIPE_CONNECT_WEBHOOK_SECRET`. Both are in `src/controllers/stripe-webhook.controller.ts` and are mounted in `src/app.ts` with the raw request body, **before** `express.json()`. Stripe signs the exact bytes it sends, so a parsed body would never match. Don't move them below the JSON parser.
- **Signatures.** Each call's `Stripe-Signature` is checked against its secret (`src/payments/stripe-client.ts`). Forged, tampered or unsigned calls get a 400.
- **Events handled.** `src/services/stripe-webhook.service.ts` passes each platform event to every billing service, and each acts on its own:

  | Events | What they do |
  | --- | --- |
  | `checkout.session.completed`, `checkout.session.async_payment_succeeded` | Settle a client top-up, an AI top-up or a subscription checkout as paid; a session in setup mode saves a card on file |
  | `checkout.session.async_payment_failed`, `checkout.session.expired` | Settle it as failed |
  | `payment_intent.succeeded`, `payment_intent.payment_failed` | Settle a quote payment, or a charge to a card on file that Stripe finished later |
  | `refund.updated`, `refund.failed` | Bring an admin's refund to Stripe's final status |
  | `charge.dispute.created`, `charge.dispute.closed` | Keep the lawyer's earning from being released while a quote payment is disputed (only while it's still PENDING); reverse it if the dispute is lost |
  | `transfer.reversed` | Return a withdrawal's money to the available balance if its transfer is reversed before the payout is paid |
  | `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` | Keep a lawyer's subscription plan in step: renewals, failed renewals, changes and cancellations |
  | `account.updated`, `payout.paid`, `payout.failed` (connect endpoint) | Update a lawyer's payout account; finish a withdrawal, or return its money if the payout failed |

  Anything else is acknowledged and ignored. `npm run stripe:listen` forwards exactly this list (the `stripe-cli` service in `docker-compose.yml`). When the API handles a new event, add it there, here, and to the deployed endpoints.
- **Never applied twice.** Every handled event is recorded in `StripeWebhookEvent` once every service has applied it, so a redelivery is answered without being applied again. If a service fails, nothing is recorded and Stripe retries; each service is idempotent, so the retry is safe.
- **Payments that aren't yours** (another developer, or a deployed environment, on the same account) are ignored.
- **The webhook isn't the only path.** The apps' status checks (e.g. `GET /api/client/payments/:id`, `GET /api/client/lawyer-requests/:id/payment`) ask Stripe directly and settle a payment that has moved on.

## Troubleshooting

| What you see | Why, and the fix |
| --- | --- |
| `500 STRIPE_NOT_CONFIGURED` | The API started before the key or secret was in `.env`. Restart it. |
| `400` from `stripe:webhook-check`'s first check, or `[400]` in the listener | Your `.env` and the running API disagree on the secret, or `.env` has another machine's secret. Run `npm run stripe:secret` again, update both webhook variables, restart the API. |
| `404` | The API on that port doesn't have the webhook route (wrong branch, or not restarted). |
| `You have not configured API keys yet` from `stripe:secret` or `stripe:listen` | `STRIPE_SECRET_KEY` isn't in `.env`. Docker Compose reads it from there. |
| `must specify events to forward using --events, --all-snapshot, or --all-thin` | You ran `stripe-cli listen` by hand without an events flag. Use `npm run stripe:listen`, or add `--events ...` or `--all-snapshot`. |
| `stripe:listen` shows `connect: connection refused` | The API isn't running, or isn't on port 3001. Set `PORT` in `.env` if you use another. |
| On Linux, `stripe:listen` can't reach the API | The compose file maps `host.docker.internal` to your machine (`extra_hosts`). Make sure the API listens on `0.0.0.0` (it does by default), not only `127.0.0.1`. |
| Payments stay `PENDING` | `stripe:listen` isn't running. Most still settle when the app checks their status, or when a 35-minute checkout expires. |
| Payout onboarding fails, or "You can only create new accounts if you've signed up for Connect" | Connect isn't turned on in the account's test mode. Ask the account owner. |
| A withdrawal fails with insufficient funds | The client's payment is still in Stripe's pending balance. Pay with `4000 0000 0000 0077` next time. |
| A withdrawal stays on its way | Connect events aren't reaching you: check the listener shows `payout.paid` going to `/api/webhooks/stripe-connect`, and that `STRIPE_CONNECT_WEBHOOK_SECRET` is set. |
| `invalid_request_error` / `Invalid API Key` | The key is wrong, from another Stripe account, or was rolled. Copy it from the dashboard again. |
| A dozen payment tests fail | `.env` switches a flow to Stripe. See [Running the API tests](#running-the-api-tests). |

## Deployed environments

These don't use the CLI. Each has two webhook endpoints in the Stripe dashboard (**Developers → Webhooks → Add endpoint**), each with its own signing secret in GitHub:

1. **The platform's events** at `/api/webhooks/stripe`, with the fifteen platform events listed in [How it works](#how-it-works). An endpoint missing the subscription events never sees a renewal or a cancellation: the lawyer keeps last period's allowance, or keeps a plan they no longer pay for.
2. **Connected accounts' events** at `/api/webhooks/stripe-connect`: when adding the endpoint, choose **Events on Connected accounts**, with `account.updated`, `payout.paid` and `payout.failed`. Only needed once `PAYOUT_PROVIDER` is `stripe` there.

| Environment | Base URL | GitHub environment | Variables (var) and secrets (secret) |
| --- | --- | --- | --- |
| Dev | `https://uk-dev.ilovelawyer.com` | `staging` | var `DEV_CLIENT_PAYMENT_PROVIDER`, var `DEV_LAWYER_PAYMENT_PROVIDER`, var `DEV_QUOTATION_PAYMENT_PROVIDER`, var `DEV_PAYOUT_PROVIDER`, secret `STRIPE_SECRET_KEY`, secret `STRIPE_PUBLISHABLE_KEY`, secret `STRIPE_WEBHOOK_SECRET`, secret `STRIPE_CONNECT_WEBHOOK_SECRET` |
| Staging | `https://api.ilovelawyer.com` | `production` | var `CLIENT_PAYMENT_PROVIDER`, var `LAWYER_PAYMENT_PROVIDER`, var `QUOTATION_PAYMENT_PROVIDER`, var `PAYOUT_PROVIDER`, secret `STRIPE_SECRET_KEY`, secret `STRIPE_PUBLISHABLE_KEY`, secret `STRIPE_WEBHOOK_SECRET`, secret `STRIPE_CONNECT_WEBHOOK_SECRET` |
| UK | `https://uk.ilovelawyer.com` | `production` | the same names, prefixed `UK_` |

A provider variable that isn't set means that flow's dummy, so an environment changes nothing until someone sets it. To take quote payments or pay lawyers out with Stripe in an environment:

1. Set its `QUOTATION_PAYMENT_PROVIDER` and `PAYOUT_PROVIDER` variables to `stripe` (with the environment's prefix).
2. Add the connect endpoint in Stripe, and put its signing secret in `STRIPE_CONNECT_WEBHOOK_SECRET` (with the prefix).
3. Make sure the platform endpoint has all fifteen platform events, and that Connect is turned on in that Stripe account.
4. Deploy. The values only reach the server on the next deploy.

UK's names are prefixed because `deploy-uk.yml` and staging read the same GitHub environment; without the prefix they would share one set of Stripe keys. Dev and staging use test-mode keys. UK uses live keys only once it takes real payments.

The webhooks are under `/api` because the dev and UK hosts share a domain with a frontend and only send `/api/*` to the API.
