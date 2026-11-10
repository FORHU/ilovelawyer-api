/** Changing your username (PATCH /api/users/me, FORHU/ilovelawyer-api#642): the same rules as the
 * lawyer app's Profile form (letters, numbers, dots, underscores and hyphens, 3 to 30), and a readable
 * message with a code when one is refused, never Joi's raw text. Against the real database. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";

describe("changing your username", function () {
  this.timeout(20_000);
  const userId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const tag = crypto.randomUUID().slice(0, 8);
  const auth = { Authorization: `Bearer ${loginToken(userId, false).accessToken}` };
  const change = (username: unknown) => request(app).patch("/api/users/me").set(auth).send({ username });

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    await prisma.user.createMany({
      data: [
        { id: userId, email: `uname-${userId}@example.com`, username: `uname-${tag}-a`, name: "Jane Smith", role: "LAWYER", tenantId: tenant.id },
        { id: otherId, email: `uname-${otherId}@example.com`, username: `taken_${tag}`, name: "Other", role: "LAWYER", tenantId: tenant.id },
      ],
    });
  });

  after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  });

  it("accepts hyphens, as the Profile form does", async () => {
    const username = `jane-smith-${tag}`;
    const { body } = await change(username).expect(200);
    expect(body.username).to.equal(username);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).username).to.equal(username);
  });

  it("still accepts letters, numbers, dots and underscores", async () => {
    await change(`jane.smith_${tag}`).expect(200);
  });

  it("refuses other characters with a readable message and INVALID_USERNAME", async () => {
    for (const username of ["jane smith", "jane@smith", "jäne"]) {
      const { body } = await change(username).expect(400);
      expect(body).to.deep.include({ code: "INVALID_USERNAME", message: "Usernames can only contain letters, numbers, dots, underscores and hyphens." });
    }
  });

  it("refuses one that's too short or too long", async () => {
    expect((await change("ab").expect(400)).body).to.deep.include({ code: "INVALID_USERNAME", message: "Username must be at least 3 characters." });
    expect((await change("a".repeat(31)).expect(400)).body).to.deep.include({ code: "INVALID_USERNAME", message: "Username can be at most 30 characters." });
    await change(`b${tag}`.padEnd(30, "c")).expect(200);
  });

  it("refuses one someone else has, with USERNAME_TAKEN", async () => {
    const { body } = await change(`taken_${tag}`).expect(409);
    expect(body).to.deep.include({ code: "USERNAME_TAKEN", message: "That username is taken. Try another one." });
  });

  it("never sends Joi's own wording", async () => {
    const { body } = await change("jane smith").expect(400);
    expect(body.message).to.not.include('"username"').and.not.include("pattern");
  });
});
