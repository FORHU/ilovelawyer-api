# Data residency — UK stack data flow

Tracks #319 (EU-grade security and data protection). Facts below come from the code and the
deploy workflows. Anything marked **TO CONFIRM** cannot be seen from the repo (it lives in GitHub
secrets/variables or a third party's terms) and needs someone with access to fill it in.

## Stacks

| Stack | Workflow | AWS region | Document bucket |
|---|---|---|---|
| UK | `.github/workflows/deploy-uk.yml` | `eu-west-2` | `ilovelawyer-uk` (`AWS_S3_REGION=eu-west-2`) |
| Singapore (production) | `.github/workflows/deploy-production.yml` | `ap-southeast-1` | `AWS_S3_BUCKET` secret |

## Environments

| URL | Tenant | Runs in | Purpose |
|---|---|---|---|
| `uk.ilovelawyer.com` | UK | `eu-west-2` (UK stack) | UK production. This is the environment that must keep UK customer data in the UK. |
| `uk-dev.ilovelawyer.com` | UK | `ap-southeast-1` (Singapore stack) | Sandbox and testbed. A UK tenant served from Singapore on purpose. Holds test data only. |

Do not add a rule that blocks a UK-tenant user on a non-UK stack: it would lock out `uk-dev`.
Residency is judged against `uk.ilovelawyer.com`. (Source: the team; the URLs are not in the repo.)

## Bucket history

The UK bucket was moved from `ilovelawyer-dev` (ap-southeast-1) to `ilovelawyer-uk` (eu-west-2)
in b0c7d245. Existing files were copied across by maegju (believed; not verified).

Container images for both stacks are stored in ECR `ap-southeast-1` (`ECR_REGION`). Images hold
code, not customer data.

## Where UK customer data goes

| Data / processing | Where | Region | Notes |
|---|---|---|---|
| Uploaded documents | S3 `ilovelawyer-uk` | eu-west-2 | `AWS_S3_REGION` |
| Background jobs (SQS queues) | SQS | eu-west-2 | queue URLs built from `AWS_REGION` |
| Scanned-PDF OCR | Textract | `AWS_S3_REGION` | must match the bucket's region; see `src/utils/ocr.ts` |
| Image OCR (bytes) | Textract | `AWS_REGION` | |
| Audio transcription | Transcribe | `AWS_REGION` | |
| Speech synthesis | Polly | `AWS_REGION` | |
| Database | `UK_DATABASE_URL` secret | **TO CONFIRM** | |
| Redis | `UK_REDIS_HOST` variable | **TO CONFIRM** | |
| Chat Wonder service | `UK_CHAT_WONDER_API_URL` variable | **TO CONFIRM** | runs the LLM calls |
| LLM provider (OpenAI) | OpenAI API | **TO CONFIRM** | retention/training terms tracked in FORHU/chat-wonder-v2-api#116 |
| Jev pilots | TypeSafe (`@typesafe-ai/sdk`) | **TO CONFIRM** | only when a `USE_JEV_*` flag is on |
| Email | SMTP via nodemailer (`src/utils/mailer.ts`) | **TO CONFIRM** | |
| Google sign-in / Calendar | Google | **TO CONFIRM** | |

## Startup check

`verifyDocumentBucketRegion()` (`src/utils/s3.ts`) runs at boot, asks S3 where the document bucket
really is, and logs a warning if that differs from `AWS_S3_REGION`. It never blocks startup.
