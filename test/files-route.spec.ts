/** /files — GET /resolve must stay public (no validSession), since ilovelawyer-app's
 * /files/[token] Route Handler calls it server-to-server with only the proxy token as auth, and
 * no browser <a>/<audio>/<iframe> src can carry a Bearer header. POST /upload must stay behind
 * validSession, unchanged. Goes through real HTTP with supertest against the real route and the
 * real error handler, same idiom as test/generated-document-route.spec.ts; only FilesSvc is
 * stubbed.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import express from "express";
import request from "supertest";
import filesRoute from "../src/routes/files.route";
import errorHandler from "../src/middleware/error-handler.middleware";
import FilesSvc from "../src/services/files.service";
import HttpError from "../src/utils/http-error";

const app = express();
app.use(express.json());
app.use("/files", filesRoute);
app.use(errorHandler);

describe("/files route wiring", () => {
  const originals = { resolve: FilesSvc.resolve, upload: FilesSvc.upload };
  let resolveCalls: string[];

  beforeEach(() => {
    resolveCalls = [];
  });

  afterEach(() => {
    (FilesSvc as any).resolve = originals.resolve;
    (FilesSvc as any).upload = originals.upload;
  });

  describe("GET /files/resolve", () => {
    it("is reachable with no Authorization header at all (the token is the auth)", async () => {
      (FilesSvc as any).resolve = async (token: string) => {
        resolveCalls.push(token);
        return "https://s3.example/presigned/generated-documents/abc.pdf";
      };

      const res = await request(app).get("/files/resolve").query({ token: "good-token" });

      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({ url: "https://s3.example/presigned/generated-documents/abc.pdf" });
      expect(resolveCalls).to.deep.equal(["good-token"]);
    });

    it("returns a generic 404 (no leaked detail) when FilesSvc.resolve rejects the token", async () => {
      (FilesSvc as any).resolve = async () => {
        throw new HttpError("Not found", 404);
      };

      const res = await request(app).get("/files/resolve").query({ token: "bad-token" });

      expect(res.status).to.equal(404);
      expect(res.body).to.deep.equal({ message: "Not found" });
    });

    it("returns 404 without calling the service when the token query param is missing", async () => {
      (FilesSvc as any).resolve = async (token: string) => {
        resolveCalls.push(token);
        return "https://s3.example/presigned/x";
      };

      const res = await request(app).get("/files/resolve");

      expect(res.status).to.equal(404);
      expect(resolveCalls).to.have.length(0);
    });
  });

  describe("POST /files/upload", () => {
    it("still rejects a request with no Authorization header (401), without calling the service", async () => {
      let uploadCalled = false;
      (FilesSvc as any).upload = async () => {
        uploadCalled = true;
        return {};
      };

      const res = await request(app).post("/files/upload").attach("file", Buffer.from("bytes"), "doc.pdf");

      expect(res.status).to.equal(401);
      expect(uploadCalled).to.equal(false);
    });
  });
});
