/** POST /api/admin/users/:id/export — an admin produces someone's data export for them. Runs the
 * real route against the real database, like the organization specs: creates its own users and
 * rows, and removes them. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import request from "supertest";
import JSZip from "jszip";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("POST /api/admin/users/:id/export", () => {
  const adminId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  const strangerId = crypto.randomUUID();
  const otherAdminId = crypto.randomUUID();
  const ids = [adminId, targetId, strangerId, otherAdminId];
  const asUser = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const post = (id: string, as: string, body: object) =>
    request(app).post(`/api/admin/users/${id}/export`).set(asUser(as)).send(body).buffer(true).parse(binary);

  before(async () => {
    await prisma.user.create({ data: { id: adminId, email: `adm-${adminId}@example.com`, username: `adm-${adminId}`, role: "ADMIN" } });
    await prisma.user.create({ data: { id: otherAdminId, email: `adm-${otherAdminId}@example.com`, username: `adm-${otherAdminId}`, role: "ADMIN" } });
    await prisma.user.create({ data: { id: targetId, email: `target-${targetId}@example.com`, username: `target-${targetId}`, name: "Target Person" } });
    await prisma.user.create({ data: { id: strangerId, email: `stranger-${strangerId}@example.com`, username: `stranger-${strangerId}` } });
  });

  after(async () => {
    await prisma.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { payload: { path: ["userId"], equals: targetId } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("refuses without the identity confirmation, and never defaults it", async () => {
    const none = await post(targetId, adminId, {});
    expect(none.status).to.equal(400);
    const falsy = await post(targetId, adminId, { identityVerified: false });
    expect(falsy.status).to.equal(400);
    const text = await post(targetId, adminId, { identityVerified: "true" });
    expect(text.status, "only a real boolean true counts").to.equal(400);
  });

  it("refuses a caller who is not an admin", async () => {
    const res = await post(targetId, strangerId, { identityVerified: true });
    expect(res.status).to.equal(403);
  });

  it("will not export another admin's account, or an account that does not exist", async () => {
    expect((await post(otherAdminId, adminId, { identityVerified: true })).status).to.equal(404);
    expect((await post(crypto.randomUUID(), adminId, { identityVerified: true })).status).to.equal(404);
  });

  it("returns the target's zip, not the admin's, and records who did it", async () => {
    const res = await post(targetId, adminId, { identityVerified: true });
    expect(res.status).to.equal(200);
    expect(res.headers["content-type"]).to.include("application/zip");

    const zip = await JSZip.loadAsync(res.body as Buffer, { checkCRC32: true });
    expect(Object.keys(zip.files)).to.include.members(["data.json", "README.pdf"]);
    const doc = JSON.parse(await zip.file("data.json")!.async("string"));
    expect(doc.user).to.include({ id: targetId });
    expect(JSON.stringify(doc)).to.not.include(`adm-${adminId}@example.com`);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const event = await prisma.auditEvent.findFirst({ where: { action: "account.data_export_by_admin", actorId: adminId } });
    expect(event, "the admin export must be in the audit trail").to.not.equal(null);
    expect(event!.payload).to.include({ userId: targetId });
  });
});
