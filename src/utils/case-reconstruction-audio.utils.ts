/** Polly's own OutputUri is the authoritative, guaranteed-correct link to what it wrote —
 * trust it directly rather than reconstructing the key from OutputS3KeyPrefix + TaskId
 * (undocumented separator convention, not worth guessing). This just extracts a bucket-
 * relative s3Key from it for the File row, matching this codebase's File.s3Key convention;
 * fileUrl (the only field <audio src> actually needs) is Polly's OutputUri unmodified. */
export function keyFromOutputUri(outputUri: string, bucket: string): string {
  try {
    const url = new URL(outputUri);
    let path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (path.startsWith(`${bucket}/`)) path = path.slice(bucket.length + 1);
    return path;
  } catch {
    return outputUri;
  }
}
