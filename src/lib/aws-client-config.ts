import { AWS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY, AWS_REGION } from "../config";

/** Credentials fragment for every AWS SDK v3 client in this app.
 *
 * Spread it — never pass `credentials` unconditionally. Handing the SDK a
 * `credentials` object makes it treat those values as static credentials and
 * skip its provider chain entirely, so an EC2 instance role is never consulted.
 * With the keys unset that yields `{ accessKeyId: undefined }`, which SigV4
 * rejects at signing time with "Resolved credential object is not valid" —
 * every S3 presign and SQS poll fails, silently, at runtime.
 *
 * Omitting the key instead lets the chain resolve: env vars, then shared
 * config, then the instance role. Singapore sets AWS_ACCESS_KEY and keeps its
 * static credentials; London sets neither and uses its instance role. */
export const awsCredentials =
  AWS_ACCESS_KEY && AWS_SECRET_ACCESS_KEY
    ? { credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_ACCESS_KEY } }
    : {};

/** Region + credentials, for clients that need no further configuration. */
export const awsClientConfig = { region: AWS_REGION, ...awsCredentials };
