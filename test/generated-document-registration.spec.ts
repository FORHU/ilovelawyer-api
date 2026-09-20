/** api#90 — the generated-document route is actually mounted on the app router. Goes through the real app:
 * an unauthenticated POST gets 401 from apiKeyMiddleware when the route is registered, and 404 when it is not.
 */
import { expect } from "chai";
import request from "supertest";
import { describe, it } from "mocha";
import app from "../src/app";

describe("generated-document route registration", () => {
  for (const base of ["/api/v1", "/api"]) {
    it(`is mounted at ${base}/generated-document and guarded by the api key`, async () => {
      const res = await request(app).post(`${base}/generated-document`).send({ documentName: "Doc", content: "Body" });
      expect(res.status).to.equal(401); // 404 would mean the route is not mounted
      expect(res.body.message).to.equal("Unauthorized");
    });
  }
});
