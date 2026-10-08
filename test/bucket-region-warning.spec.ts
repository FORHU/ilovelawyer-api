/** bucketRegionWarning — the pure half of the startup check that the document bucket lives in
 * AWS_S3_REGION (UK data residency). No AWS calls. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { bucketRegionWarning } from "../src/utils/s3";

describe("bucketRegionWarning", () => {
  it("is silent when the bucket is in the configured region", () => {
    expect(bucketRegionWarning("eu-west-2", "eu-west-2")).to.equal(null);
  });

  it("is silent when the real region is unknown", () => {
    expect(bucketRegionWarning(undefined, "eu-west-2")).to.equal(null);
  });

  it("names both regions when the bucket is elsewhere", () => {
    const msg = bucketRegionWarning("ap-southeast-1", "eu-west-2");
    expect(msg).to.be.a("string");
    expect(msg).to.include("ap-southeast-1").and.to.include("eu-west-2");
  });
});
