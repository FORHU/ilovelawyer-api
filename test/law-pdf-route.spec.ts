/** GET /api/law/:lawId/pdf — the Library viewer's same-origin document proxy. No database or
 * upstream: LawRepo.findById and global fetch are monkeypatched. */
import { expect } from "chai";
import { describe, it, afterEach } from "mocha";
import request from "supertest";
import type { Law } from "@prisma/client";
import app from "../src/app";
import LawRepo from "../src/repositories/law.repository";

type Patch = [object, string, unknown];
const restores: Patch[] = [];
function patch(patches: Patch[]) {
  for (const [target, key, value] of patches) {
    restores.push([target, key, (target as any)[key]]);
    (target as any)[key] = value;
  }
}
function restoreAll() {
  while (restores.length) {
    const [target, key, value] = restores.pop()!;
    (target as any)[key] = value;
  }
}

const ILOTT = {
  id: "law-ilott",
  jurisUrl: "https://caselaw.nationalarchives.gov.uk/uksc/2017/17",
  pdfUrl: "https://assets.caselaw.nationalarchives.gov.uk/uksc/2017/17/uksc_2017_17.pdf",
} as Law;
const DATA_PDF = "https://caselaw.nationalarchives.gov.uk/uksc/2017/17/data.pdf";

function withLaw(law: Law) {
  patch([[LawRepo, "findById", async (id: string) => (id === law.id ? law : null)]]);
}

/** fetch answering per URL (anything else 404s); returns the URLs asked for. */
function upstream(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  patch([
    [
      globalThis,
      "fetch",
      async (url: string) => {
        calls.push(url);
        return routes[url]?.() ?? new Response("", { status: 404 });
      },
    ],
  ]);
  return calls;
}

const pdf = () => new Response("%PDF-1.7 generated", { status: 200, headers: { "content-type": "application/pdf" } });
const forbidden = () => new Response("<Error/>", { status: 403, headers: { "content-type": "application/xml" } });

describe("GET /api/law/:lawId/pdf", () => {
  afterEach(restoreAll);

  it("serves Ilott's judgment from TNA's data.pdf when the assets PDF 403s", async () => {
    withLaw(ILOTT);
    const calls = upstream({ [ILOTT.pdfUrl!]: forbidden, [DATA_PDF]: pdf });
    const res = await request(app).get(`/api/law/${ILOTT.id}/pdf`).buffer(true).expect(200);
    expect(res.headers["content-type"]).to.match(/^application\/pdf/);
    expect(res.headers["x-frame-options"]).to.equal(undefined);
    expect(calls).to.deep.equal([ILOTT.pdfUrl, DATA_PDF]);
  });

  it("answers 502 LAW_DOCUMENT_UNAVAILABLE, without upstream detail, when every candidate fails", async () => {
    withLaw(ILOTT);
    upstream({
      [ILOTT.pdfUrl!]: forbidden,
      [DATA_PDF]: () => new Response("<html>Cloudflare bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
    });
    const res = await request(app).get(`/api/law/${ILOTT.id}/pdf`).expect(502);
    expect(res.body).to.deep.equal({ message: "The official document source is unavailable right now", code: "LAW_DOCUMENT_UNAVAILABLE" });
  });

  it("doesn't 404 a UK judgment with no stored pdfUrl — it tries data.pdf", async () => {
    withLaw({ ...ILOTT, pdfUrl: null });
    const calls = upstream({ [DATA_PDF]: pdf });
    await request(app).get(`/api/law/${ILOTT.id}/pdf`).buffer(true).expect(200);
    expect(calls).to.deep.equal([DATA_PDF]);
  });

  it("still 404s a document with no pdfUrl and no derivable source, without fetching", async () => {
    withLaw({ id: "law-ph", jurisUrl: "https://juris.ph/jurisprudence/12345", pdfUrl: null } as Law);
    const calls = upstream({});
    await request(app).get("/api/law/law-ph/pdf").expect(404);
    expect(calls).to.deep.equal([]);
  });

  it("only asks a PH decision's stored pdfUrl", async () => {
    const PH = { id: "law-ph", jurisUrl: "https://juris.ph/jurisprudence/12345", pdfUrl: "https://juris.ph/files/12345.pdf" } as Law;
    withLaw(PH);
    const calls = upstream({ [PH.pdfUrl!]: pdf });
    await request(app).get(`/api/law/${PH.id}/pdf`).buffer(true).expect(200);
    expect(calls).to.deep.equal([PH.pdfUrl]);
  });

  it("never fetches from a jurisUrl off TNA's origin", async () => {
    withLaw({ id: "law-bad", jurisUrl: "https://evil.example/uksc/2017/17", pdfUrl: null } as Law);
    const calls = upstream({});
    await request(app).get("/api/law/law-bad/pdf").expect(404);
    expect(calls).to.deep.equal([]);
  });
});
