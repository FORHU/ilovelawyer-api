import { expect } from "chai";
import request from "supertest";
import app from "../src/app";
import { describe, it } from "mocha";

describe("App", () => {
  // The welcome message lives on the health check (HealthCtrl.check), which also reports the
  // database and Redis; there is no route at the bare /api/v1.
  it("should return a welcome message and a healthy status", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).to.equal(200);
    expect(res.body).to.include({ message: "Welcome to my API", status: "ok", database: "up", redis: "up" });
  });
});
