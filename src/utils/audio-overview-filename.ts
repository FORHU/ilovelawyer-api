/** Name a downloaded Audio Overview is saved under — the S3 key is a UUID, so without this the file
 * takes that name (see getPresignedGetUrl). Minute-precision UTC so several overviews generated on
 * one day don't all save as the same file. */
export function audioOverviewFilename(createdAt: Date): string {
  return `audio-overview-${createdAt.toISOString().slice(0, 16).replace("T", "-").replace(":", "")}.mp3`;
}
