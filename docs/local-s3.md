# Local S3 (LocalStack)

By default the API talks to a **real AWS S3 bucket** for every upload, download and presigned URL. Locally, that means every developer either shares one dev bucket (clutter, cost, and one developer's test files sitting next to everyone else's) or needs real AWS keys just to run the app. `AWS_S3_ENDPOINT` redirects the S3 client at **LocalStack**, an S3-compatible emulator that runs in Docker on your own machine — free, isolated per developer. It's the same LocalStack instance already in `docker-compose.yml` for the per-developer SQS emulator; this just turns on its S3 service too.

Nothing about this affects deployed environments: `AWS_S3_ENDPOINT` is unset everywhere except your local `.env`, so production/staging/dev keep talking to real AWS S3 exactly as before.

> This used to run on MinIO instead. That was switched to LocalStack because both of MinIO's registries (Docker Hub and Quay) now require a login to pull `minio/minio`/`minio/mc`, which broke the setup for anyone without a MinIO registry account. LocalStack's image has no such restriction.

## Before you start

Once per developer:

- **Docker Desktop** installed and running.
- **The API cloned and `.env` copied from `.env.example`.**

## Setup

Once per machine. Commands are for a terminal in `ilovelawyer-api` (Git Bash on Windows).

### 1. Point S3 at LocalStack in `.env`

Comment out your real AWS values (if you have any) and add:

```env
AWS_S3_ENDPOINT=http://localhost:4566
AWS_ACCESS_KEY=test
AWS_SECRET_ACCESS_KEY=test
AWS_S3_BUCKET=ilovelawyer-local
AWS_REGION=us-east-1
```

Leave `CLOUDFRONT_URL` **unset**. `s3UrlForKey` (`src/utils/s3.ts`) checks `CLOUDFRONT_URL` before `AWS_S3_ENDPOINT` — if both are set, raw file URLs point at your real CloudFront distribution for a key that only exists in LocalStack, which 404s. `test`/`test` are LocalStack's conventional dummy credentials (it doesn't actually check them); `AWS_REGION` just needs to match whatever `DEFAULT_REGION` your compose setup is using so the SDK signs requests the same way LocalStack expects.

### 2. Start it

```bash
docker compose up -d
```

This starts (or updates) `localstack` with its S3 service enabled, which creates the `AWS_S3_BUCKET` bucket and makes it anonymously downloadable on every startup (see `docker/localstack-init/ready-create-bucket.sh`), alongside Postgres, Redis and SQS as before.

### 3. Restart the API

The API reads `.env` only at startup. Stop `npm run dev` and start it again after any `.env` change.

### 4. Check it

```bash
docker compose exec localstack awslocal s3 ls s3://ilovelawyer-local
```

Upload a document through the app and confirm it shows up there.

## Each time you work locally

| Terminal | Command | Why |
| --- | --- | --- |
| any | `docker compose up -d` | Postgres, Redis, LocalStack (SQS **and S3**) |
| 1 | `npm run dev` | The API |

Nothing else changes — uploads, downloads, and presigned URLs all go through LocalStack transparently; the app code doesn't know the difference.

## How it works

- `src/config.ts` exports `AWS_S3_ENDPOINT` (unset in prod, same pattern as `AWS_SQS_ENDPOINT`).
- `src/utils/s3.ts`'s `S3Client` adds `endpoint: AWS_S3_ENDPOINT` and `forcePathStyle: true` when it's set. `forcePathStyle` is required because LocalStack doesn't support virtual-hosted-style buckets (`bucket.s3.amazonaws.com`) — only path-style (`s3.amazonaws.com/bucket`).
- `s3UrlForKey` also builds a path-style LocalStack URL (`${AWS_S3_ENDPOINT}/${AWS_S3_BUCKET}/${key}`) when `AWS_S3_ENDPOINT` is set and `CLOUDFRONT_URL` isn't.
- `docker/localstack-init/ready-create-bucket.sh` runs on every LocalStack startup and creates+publicizes whatever bucket `AWS_S3_BUCKET` names, so it always matches your `.env`. LocalStack keeps buckets in memory only, so this has to re-run on every restart — same reasoning as `ready-create-queues.sh` for SQS queues.

## ⚠️ Textract (OCR) will NOT work locally — and can't be made to

LocalStack Community Edition only replaces generic S3 storage (upload/download/presign). It does **not**, and cannot, make AWS Textract (OCR for scanned PDFs and images, `src/utils/ocr.ts`) work locally. This isn't a config gap we can fix — it's a hard limit of how the Textract API is built:

- `ocrImageFromS3` and `ocrPdfFromS3` don't send Textract the file's bytes. They send it `{ Bucket, Key }` and tell **real AWS Textract** to go fetch the object itself, over AWS's internal network, using IAM-authenticated `S3.GetObject`.
- Textract runs on AWS's infrastructure. It has no route to `http://localhost:4566` on your laptop — there's no credential, tunnel, or client-side fix that changes that. A document that only exists in your local LocalStack is simply unreachable to Textract.
- The async API used for scanned PDFs (`StartDocumentTextDetectionCommand`) is **S3-reference-only** — it has no "send me the bytes directly" option at all, by design (it supports documents up to 500MB/3000 pages, too large to upload inline). So this isn't fixable even by having our code fetch the bytes itself and resend them.

**What actually happens:** every Textract call in `ocr.ts` already catches its own errors and degrades gracefully — it logs a warning and returns `""` / `[]` rather than throwing. So this doesn't crash anything; documents extracted locally simply come back with no OCR'd text for scanned PDFs/images. Everything else (direct text extraction, non-scanned documents) is unaffected.

**If you need to verify real OCR behavior:**
- Preferred: test it in a deployed environment (dev/staging) that already has real AWS wired up, rather than on your laptop.
- If you specifically need to debug OCR locally: temporarily switch `.env` back to real AWS credentials and a real S3 bucket (comment out the four LocalStack lines above), upload the file there, and switch back to LocalStack afterward. Expect a small Textract cost for this test run.
- Do **not** reach for a different local OCR engine (e.g. Tesseract) as a stand-in — it produces different text, different layout/structure, and different accuracy than Textract. For a product where OCR'd text feeds legal-document analysis, testing against a different engine than production runs on risks masking real extraction bugs instead of catching them.
