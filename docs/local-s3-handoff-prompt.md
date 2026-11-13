# Handoff prompt: set up local S3 (LocalStack)

Paste everything below into a fresh Claude Code (or similar agent) session, opened in `ilovelawyer-api`. It's self-contained — the agent doesn't need any other context from this repo's history.

---

Set up local S3 for this project using the existing LocalStack container (Docker), so I don't need real AWS credentials or a shared dev bucket to run uploads/downloads locally. The infra and code support for this already exists in this repo — you're only wiring up my local environment, not writing new code.

**As of 2026-11-13 this is on PR #660 (branch `feature/local-s3-localstack`), not yet merged to `main`.** Check which one you're on first; if `main` doesn't have it yet, check out that branch (`git fetch origin && git checkout feature/local-s3-localstack`) before continuing. Once #660 merges, this will just be on `main` and this note no longer applies.

Do this:

1. Read `.env` in this directory (`ilovelawyer-api/.env`). If it doesn't exist, run `cp .env.example .env` first.
2. Find the AWS block (`AWS_ACCESS_KEY`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, `AWS_REGION`, possibly `CLOUDFRONT_URL`). If any of those are set to real-looking values (not already LocalStack's dummy values), comment them out (`#` prefix) rather than deleting them, so they can be restored later.
3. In their place, add exactly:
   ```env
   AWS_S3_ENDPOINT=http://localhost:4566
   AWS_ACCESS_KEY=test
   AWS_SECRET_ACCESS_KEY=test
   AWS_S3_BUCKET=ilovelawyer-local
   AWS_REGION=ap-southeast-1
   ```
4. Make sure `CLOUDFRONT_URL` is unset or commented out. Do not set it alongside `AWS_S3_ENDPOINT` — `s3UrlForKey` in `src/utils/s3.ts` checks `CLOUDFRONT_URL` first, so if both are set, file URLs resolve to a real CloudFront host for a key that only exists in LocalStack, which 404s. `AWS_REGION` must be `ap-southeast-1` to match `docker-compose.yml`'s `DEFAULT_REGION` default — LocalStack keeps queues/buckets per region, so a mismatch here silently breaks SQS too, not just S3.
5. Confirm `docker-compose.yml`'s `localstack` service has `SERVICES=sqs,s3` (not just `sqs`), and that `docker/localstack-init/ready-create-bucket.sh` exists. Both should be there once you're on the right branch/commit (see the note above). If they're missing, stop and tell me — don't try to add them yourself.
6. Run `docker compose up -d` and confirm `ilovelawyer-localstack` comes up healthy (`docker compose ps`). If you'd previously set up MinIO for this project (an older approach, since replaced), remove any lingering `minio`/`minio-setup` containers or `minio_data` volume — they're no longer part of this setup.
7. Tell me to restart `npm run dev` myself (the API only reads `.env` at startup) — don't attempt to manage that process for me.
8. Verify: `docker compose exec localstack awslocal s3 ls s3://ilovelawyer-local` should succeed without error (bucket exists, even if empty).

Explicitly do NOT touch, patch, or "fix" anything in `src/utils/ocr.ts`. Real AWS Textract (used there) cannot reach local LocalStack under any configuration — it's an AWS-side network/IAM limitation, not something fixable in this codebase. If OCR doesn't work locally after this setup, that's expected: Textract calls there already fail gracefully (caught, logged, return `""`/`[]`), nothing crashes. If I ask about it, explain the limitation; don't attempt a workaround (and specifically don't suggest or build a different local OCR engine as a stand-in — this is a legal-document product where OCR fidelity to production matters, and a different engine would validate against the wrong thing).

Report back: what you changed in `.env`, confirmation the container is healthy, and the manual steps left for me (restarting `npm run dev`, re-testing uploads in the app).
