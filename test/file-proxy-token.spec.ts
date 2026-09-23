/** getProxyFileUrl (src/utils/s3.ts) / FilesSvc.resolve (src/services/files.service.ts) — the
 * signed `/files/<token>` link that stands in for a raw presigned S3 URL. getPresignedGetUrl
 * (the only thing FilesSvc.resolve is allowed to call) is monkeypatched on its CommonJS module
 * object, same idiom as test/decision-record-service.spec.ts, so no real AWS call happens.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import jwt from "jsonwebtoken";
import * as s3 from "../src/utils/s3";
import { getProxyFileUrl } from "../src/utils/s3";
import FilesSvc from "../src/services/files.service";
import HttpError from "../src/utils/http-error";
import { FILE_TOKEN_SECRET } from "../src/config";

function tokenFromProxyUrl(url: string): string {
  return url.replace(/^\/files\//, "");
}

describe("getProxyFileUrl / FilesSvc.resolve", () => {
  const originals = { getPresignedGetUrl: s3.getPresignedGetUrl };
  let presignCalls: { key: string; expiresIn?: number; filename?: string; disposition?: string }[];

  beforeEach(() => {
    presignCalls = [];
    (s3 as any).getPresignedGetUrl = async (
      key: string,
      expiresIn?: number,
      filename?: string,
      disposition?: string,
    ) => {
      presignCalls.push({ key, expiresIn, filename, disposition });
      return `https://s3.example/presigned/${key}`;
    };
  });

  afterEach(() => {
    (s3 as any).getPresignedGetUrl = originals.getPresignedGetUrl;
  });

  async function expectRejected(token: string) {
    let thrown: unknown;
    try {
      await FilesSvc.resolve(token);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).to.be.instanceOf(HttpError);
    expect((thrown as HttpError).statusCode).to.equal(404);
    // Never echo the jwt library's own error message (e.g. "jwt expired") — it would confirm
    // to an attacker that the token is a JWT at all.
    expect((thrown as HttpError).message).to.equal("Not found");
    expect(presignCalls).to.have.length(0);
  }

  it("round-trips: resolve() mints a fresh 60s presigned GET for the key/filename/disposition getProxyFileUrl signed", async () => {
    const url = getProxyFileUrl("generated-documents/abc.pdf", { filename: "Affidavit.pdf", disposition: "attachment" });
    expect(url).to.match(/^\/files\/.+/);

    const resolved = await FilesSvc.resolve(tokenFromProxyUrl(url));

    expect(resolved).to.equal("https://s3.example/presigned/generated-documents/abc.pdf");
    expect(presignCalls).to.deep.equal([
      { key: "generated-documents/abc.pdf", expiresIn: 60, filename: "Affidavit.pdf", disposition: "attachment" },
    ]);
  });

  it("defaults to attachment disposition and no filename when none is given", async () => {
    const url = getProxyFileUrl("case-briefs/case-1/123.pdf");
    await FilesSvc.resolve(tokenFromProxyUrl(url));
    expect(presignCalls).to.deep.equal([
      { key: "case-briefs/case-1/123.pdf", expiresIn: 60, filename: undefined, disposition: "attachment" },
    ]);
  });

  it("rejects an expired token as a generic 404", async () => {
    const expired = jwt.sign({ s3Key: "k", disposition: "attachment" }, FILE_TOKEN_SECRET, { expiresIn: -10 });
    await expectRejected(expired);
  });

  it("rejects a tampered token as a generic 404", async () => {
    const token = tokenFromProxyUrl(getProxyFileUrl("k"));
    const lastChar = token.at(-1);
    const tampered = token.slice(0, -1) + (lastChar === "a" ? "b" : "a");
    await expectRejected(tampered);
  });

  it("rejects a token signed with the wrong secret as a generic 404", async () => {
    const wrongSecret = jwt.sign({ s3Key: "k", disposition: "attachment" }, "not-the-real-secret", {
      expiresIn: 3600,
    });
    await expectRejected(wrongSecret);
  });

  it("rejects a well-signed token missing the s3Key claim as a generic 404", async () => {
    const noKey = jwt.sign({ disposition: "attachment" }, FILE_TOKEN_SECRET, { expiresIn: 3600 });
    await expectRejected(noKey);
  });

  it("rejects garbage input as a generic 404", async () => {
    await expectRejected("not-a-jwt-at-all");
  });
});
