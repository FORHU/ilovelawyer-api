/** Loaded before every spec (package.json "test" --require), next to the other doubles. The upload
 * content check (DocumentSvc.verifyUploads) reads the first bytes of each confirmed file from S3;
 * without this, any spec that confirms an upload with the real credentials in .env would call the
 * real bucket. The read fails here, which the check treats as "nothing to inspect"; a spec that
 * wants a file's bytes stubs getObjectHead itself, and its usual stash/restore puts this back. */
import * as s3 from "../../src/utils/s3";

(s3 as any).getObjectHead = async () => {
  throw new Error("S3 is not available in specs");
};
