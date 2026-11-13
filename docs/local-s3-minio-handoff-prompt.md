# Handoff prompt: set up local S3 (MinIO)

Paste everything below into a fresh Claude Code (or similar agent) session, opened in `ilovelawyer-api`. It's self-contained — the agent doesn't need any other context from this repo's history.

---

Set up local S3 for this project using MinIO (Docker), so I don't need real AWS credentials or a shared dev bucket to run uploads/downloads locally. The infra and code support for this already exists in this repo — you're only wiring up my local environment, not writing new code.

Do this:

1. Read `.env` in this directory (`ilovelawyer-api/.env`). If it doesn't exist, run `cp .env.example .env` first.
2. Find the AWS block (`AWS_ACCESS_KEY`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, `AWS_REGION`, possibly `CLOUDFRONT_URL`). If any of those are set to real-looking values (not already MinIO's), comment them out (`#` prefix) rather than deleting them, so they can be restored later.
3. In their place, add exactly:
   ```env
   AWS_S3_ENDPOINT=http://localhost:9000
   AWS_ACCESS_KEY=minioadmin
   AWS_SECRET_ACCESS_KEY=minioadmin
   AWS_S3_BUCKET=ilovelawyer-local
   AWS_REGION=us-east-1
   ```
4. Make sure `CLOUDFRONT_URL` is unset or commented out. Do not set it alongside `AWS_S3_ENDPOINT` — `s3UrlForKey` in `src/utils/s3.ts` checks `CLOUDFRONT_URL` first, so if both are set, file URLs resolve to a real CloudFront host for a key that only exists in MinIO, which 404s.
5. Confirm `docker-compose.yml` in this directory already has `minio` and `minio-setup` services (it should, on `main`). If it doesn't, stop and tell me — that means I'm not on a branch with this feature yet; don't try to add those services yourself.
6. Run `docker compose up -d` and confirm `ilovelawyer-minio` and `ilovelawyer-minio-setup` come up healthy (`docker compose ps`).
7. Tell me to restart `npm run dev` myself (the API only reads `.env` at startup) — don't attempt to manage that process for me.
8. Verify: `curl -I http://localhost:9001` should return a response (MinIO console is up). Optionally run `docker compose exec minio-setup mc ls local/ilovelawyer-local` (or equivalent) to confirm the bucket exists.

Explicitly do NOT touch, patch, or "fix" anything in `src/utils/ocr.ts`. Real AWS Textract (used there) cannot reach local MinIO under any configuration — it's an AWS-side network/IAM limitation, not something fixable in this codebase. If OCR doesn't work locally after this setup, that's expected: Textract calls there already fail gracefully (caught, logged, return `""`/`[]`), nothing crashes. If I ask about it, explain the limitation; don't attempt a workaround (and specifically don't suggest or build a different local OCR engine as a stand-in — this is a legal-document product where OCR fidelity to production matters, and a different engine would validate against the wrong thing).

Report back: what you changed in `.env`, confirmation the containers are healthy, and the manual steps left for me (restarting `npm run dev`, re-testing uploads in the app).
