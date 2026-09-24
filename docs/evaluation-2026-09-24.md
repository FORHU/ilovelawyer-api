# API evaluation findings (2026-09-24)

A code-reading review of `ilovelawyer-api`. **The code was not run:** dependencies weren't installed at the time, so the typecheck and test suite are unverified. Every finding below is from reading the source; line numbers are as of commit time.

**None of these are fixed yet.**

Related: web-app findings are in `ilovelawyer-app/docs/evaluation-2026-09-24.md`; desktop-shell gaps are in `ilovelawyer-desktop/docs/production-readiness.md`.

## Security, most serious first

### 1. Any logged-in user can send arbitrary email from the firm's mail account

`src/routes/send-email.route.ts`: `POST /api/send-email` accepts any `to`, `subject`, `text` and `html` and sends it through the configured mailer. The only check is `validSession`.

- **Risk:** a phishing relay. Any account (including a freshly signed-up one) can send branded email with arbitrary HTML to anyone.
- **Fix:** delete the route. The web app doesn't use it; it calls `/api/chat/consultations/:id/send-email` instead.

### 2. Anyone can change an event's RSVP without logging in

`src/routes/rsvp.route.ts`: `POST /api/rsvp/:eventId` has no authentication. Given an event id, it sets the event's `status` and `clientFeedback` and emails the lawyer, quoting a `clientEmail` the caller supplies and nobody verifies.

- **Risk:** tampering with calendar state, plus spoofed "client accepted/declined" emails to lawyers.
- **Fix:** require a signed, single-use RSVP token issued in the invitation email (bound to the event and the invited address), and take the client's email from the token, not the request body.

### 3. Hidden login bypass

`src/middleware/valid-session.middleware.ts:6-7`: a request with header `scoped-auth: <SECRET_KEY>` skips JWT verification entirely.

- Nothing in the codebase sends this header.
- It never sets `req.user`, so most handlers crash with a 500 on `req.user.userId`.
- The comparison isn't constant-time.
- **Fix:** remove it. If server-to-server access is needed, use a dedicated middleware like `api-key.middleware.ts` on specific routes.

### 4. Google Calendar webhook isn't authenticated

`src/controllers/calendar-watch-channel.controller.ts:28` (`handleWebhook`) trusts `x-goog-channel-id` alone to decide whose calendar to sync.

- **Risk:** anyone who learns a channel id can trigger syncs for that user. Channel ids are random, so this is lower risk, but they do travel in headers and logs.
- **Fix:** set a `token` when registering the watch channel and verify `X-Goog-Channel-Token` on every webhook call.

### 5. Auth endpoints have no rate limit of their own

`src/app.ts:33`: the only limit is global, 1000 requests per 15 minutes per IP, and it's off in development. `/auth/login`, `/auth/send-otp`, `/auth/verify-otp`, `/auth/forgot-password` and `/auth/reset-password` share it.

- OTP verification does cap attempts per code (`EMAIL_VERIFICATION_MAX_ATTEMPTS`), which is good.
- **Fix:** add a tight per-IP and per-email limiter on those routes (for example 5–10 per 15 minutes).

### What's already solid

- Refresh tokens rotate on every use, and each device has its own revocable Session.
- OTP codes use `crypto.randomInt`, with an attempt cap.
- Organization membership is re-checked against the database on every request (`resolve-organization.middleware.ts`), not trusted from the JWT.
- Helmet, a CORS allowlist and a global rate limit are in place.
- Raw SQL (`$queryRawUnsafe` / `$executeRawUnsafe` in `legal-rag.repository.ts`, `document-chunk.repository.ts`, `transcription-chunk.repository.ts`) uses bound parameters throughout; no injection found.
- `.env` is git-ignored. It does contain live-looking AWS, OpenAI and Google credentials, so confirm they were never committed or shared elsewhere.
- Tests exist for the riskiest boundaries: tenant isolation, document scope, callback scope, file-proxy tokens.

## Repository hygiene

- **Scratch files are committed:** `_debug_50mb.ts`, `_debug_extract.ts`, `check_chunks.js`, `seed_test_chunks.js`, `show_embedding.js`, `scripts/_tmp-docid.js`, `scripts/_tmp-e2e-test.ts`, `scripts/_tmp-serve-api.ts`, `scripts/_tmp-verify-callback.js`. Delete them or ignore them. (`_reprocess_stuck.ts` also sits in the root.)
- **Two lockfiles:** `package-lock.json` and `yarn.lock`. Pick one; use `npm ci` meanwhile so the lockfile isn't rewritten.
- **Template name:** `package.json` is still `"name": "template-api-node"`.
- **`npm test` fails on Windows:** it sets `NODE_ENV=development` inline. Use `cross-env` (already a dependency) as the `dev` script does.
- **Migration churn:** over 100 migrations, several with no name (`20260805080926_/` and others), and the case-document chunk HNSW index was restored twice.
- **Large files:** `src/services/chat.service.ts` is about 1,600 lines.
- **`/docs` is git-ignored** (`.gitignore` line 13), so new docs, including this one, need `git add -f`.

## Answer quality (benchmarks)

From `benchmarks/scores.md`:

- Brackenmoor scores are middling and unstable: from 34 to 74 across runs, most recently around 38–46.
- The grader model changed partway (`gpt-5.6-terra`, then `gpt-5.6-luna`), so earlier and later runs can't be compared.
- The latest runs score **worse with Jev on** (34 vs. 46).
- **No run has been moderated by a solicitor.** Until one is, answer quality is unproven, which matters most for a legal product.

**Recommended:** re-run Brackenmoor with one fixed grader model, and get at least one run moderated.

## Suggested order

1. Findings 1–4 (small, contained changes).
2. Auth rate limits (finding 5).
3. Hygiene cleanup.
4. A fixed-grader, moderated benchmark run.
