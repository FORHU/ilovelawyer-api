import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { describe, it, after } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";

function tokenFor(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

async function makeUser() {
  const userId = crypto.randomUUID();
  await prisma.user.create({
    data: { id: userId, email: `jur-${userId}@example.com`, username: `jur-${userId}` },
  });
  return userId;
}

describe("Organization jurisdiction is trusted-server-resolved at creation", () => {
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  after(async () => {
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("persists PH when the request Origin is the PH domain", async () => {
    const userId = await makeUser();
    createdUserIds.push(userId);

    const res = await request(app)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${tokenFor(userId)}`)
      .set("Origin", "https://ph.ilovelawyer.com")
      .send({ name: `PH Org ${userId}` });

    expect(res.status).to.equal(201);
    expect(res.body.jurisdiction).to.equal("PH");
    createdOrgIds.push(res.body.id);
  });

  it("persists UK when the request Origin is the UK domain", async () => {
    const userId = await makeUser();
    createdUserIds.push(userId);

    const res = await request(app)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${tokenFor(userId)}`)
      .set("Origin", "https://uk.ilovelawyer.com")
      .send({ name: `UK Org ${userId}` });

    expect(res.status).to.equal(201);
    expect(res.body.jurisdiction).to.equal("UK");
    createdOrgIds.push(res.body.id);
  });

  it("also resolves correctly from local dev origins, including the port", async () => {
    const userId = await makeUser();
    createdUserIds.push(userId);

    const res = await request(app)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${tokenFor(userId)}`)
      .set("Origin", "http://uk.ilovelawyer.local:3002")
      .send({ name: `UK Local Org ${userId}` });

    expect(res.status).to.equal(201);
    expect(res.body.jurisdiction).to.equal("UK");
    createdOrgIds.push(res.body.id);
  });

  it("rejects org creation when the Origin cannot be resolved to a jurisdiction", async () => {
    const userId = await makeUser();
    createdUserIds.push(userId);

    const res = await request(app)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${tokenFor(userId)}`)
      .set("Origin", "https://ilovelawyer.com")
      .send({ name: `Apex Org ${userId}` });

    expect(res.status).to.equal(400);
  });

  it("never lets a client-supplied jurisdiction override the trusted Origin-derived one", async () => {
    const userId = await makeUser();
    createdUserIds.push(userId);

    // A malicious body trying to smuggle `jurisdiction: "UK"` while actually signing up from
    // the PH domain — the Joi schema doesn't allow this key at all, so the request must fail
    // closed (400), never silently accept/ignore it and create a UK org.
    const res = await request(app)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${tokenFor(userId)}`)
      .set("Origin", "https://ph.ilovelawyer.com")
      .send({ name: `Smuggle Org ${userId}`, jurisdiction: "UK" });

    expect(res.status).to.equal(400);
  });
});
