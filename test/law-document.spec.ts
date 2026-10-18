/** LawDocumentSvc — the Library viewer's document source, with our own copies of UK legislation's HTML
 * (gzip-compressed in Postgres). No live Postgres or legislation.gov.uk: the repository and global
 * fetch are monkeypatched. */
import { gunzipSync, gzipSync } from "zlib";
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import type { Law } from "@prisma/client";
import LawDocumentSvc, { MAX_COPY_BYTES, copyPart } from "../src/services/law-document.service";
import LawDocumentCopyRepo, { type LawDocumentCopyMeta } from "../src/repositories/law-document-copy.repository";

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

const DAY = 24 * 60 * 60 * 1000;
const ACT = { id: "law-1", jurisUrl: "https://www.legislation.gov.uk/ukpga/2010/15", pdfUrl: null } as Law;
const JUDGMENT = {
  id: "law-2",
  jurisUrl: "https://caselaw.nationalarchives.gov.uk/uksc/2024/12",
  pdfUrl: "https://assets.caselaw.nationalarchives.gov.uk/uksc/2024/12/data.pdf",
} as Law;

function copy(over: Partial<LawDocumentCopyMeta> = {}): LawDocumentCopyMeta {
  return {
    id: "copy-1",
    lawId: ACT.id,
    part: "",
    sha256: "abc",
    sourceUrl: "https://www.legislation.gov.uk/ukpga/2010/15/data.html",
    bytes: 18,
    fetchedAt: new Date(Date.now() - 10 * DAY),
    checkedAt: new Date(Date.now() - 10 * DAY),
    ...over,
  };
}

/** legislation.gov.uk as seen from our servers: the PDF behind a WAF challenge, the HTML served —
 * but, as live, a 406 for an HTML request whose Accept lacks a wildcard. */
function upstreamUp(html = "<html>live</html>") {
  const calls: string[] = [];
  patch([
    [
      globalThis,
      "fetch",
      async (url: string, init?: RequestInit) => {
        calls.push(url);
        if (url.endsWith("/data.pdf")) {
          return new Response("", { status: 202, headers: { "x-amzn-waf-action": "challenge", "content-type": "text/html" } });
        }
        const accept = (init?.headers as Record<string, string> | undefined)?.accept ?? "";
        if (!accept.includes("*/*")) return new Response("Not Acceptable", { status: 406, headers: { "content-type": "text/html" } });
        return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      },
    ],
  ]);
  return calls;
}

function upstreamDown() {
  patch([
    [
      globalThis,
      "fetch",
      async () => {
        throw new Error("getaddrinfo ENOTFOUND www.legislation.gov.uk");
      },
    ],
  ]);
}

function noUpstream() {
  patch([
    [
      globalThis,
      "fetch",
      async () => {
        throw new Error("upstream must not be called");
      },
    ],
  ]);
}

describe("LawDocumentSvc.get", () => {
  let saves: { lawId: string; part: string; format: string; previous: LawDocumentCopyMeta | null }[];
  let latest: LawDocumentCopyMeta | null;
  let lookups: number;

  beforeEach(() => {
    saves = [];
    latest = null;
    lookups = 0;
    patch([
      [
        LawDocumentCopyRepo,
        "findLatest",
        async () => {
          lookups++;
          return latest;
        },
      ],
      [
        LawDocumentSvc,
        "save",
        async (lawId: string, part: string, doc: { format: string }, previous: LawDocumentCopyMeta | null) => {
          saves.push({ lawId, part, format: doc.format, previous });
        },
      ],
      [LawDocumentCopyRepo, "findContent", async () => gzipSync(Buffer.from("<html>saved</html>"))],
    ]);
  });

  afterEach(restoreAll);

  it("serves a fresh saved copy without calling legislation.gov.uk", async () => {
    noUpstream();
    latest = copy();
    const doc = await LawDocumentSvc.get(ACT, null);
    expect(doc?.format).to.equal("html");
    expect(doc?.body.toString()).to.equal("<html>saved</html>");
    expect(doc?.copy).to.deep.equal({ checkedAt: latest.checkedAt, stale: false });
    expect(saves).to.deep.equal([]);
  });

  it("fetches live and saves the HTML when there is no copy yet", async () => {
    const calls = upstreamUp();
    const doc = await LawDocumentSvc.get(ACT, "29");
    expect(doc?.body.toString()).to.equal("<html>live</html>");
    expect(doc?.copy).to.equal(undefined);
    expect(calls).to.deep.equal(["https://www.legislation.gov.uk/ukpga/2010/15/section/29/data.html"]);
    expect(saves).to.deep.equal([{ lawId: ACT.id, part: "section/29", format: "html", previous: null }]);
  });

  it("refetches once the copy is over 90 days old, and saves the new version", async () => {
    upstreamUp();
    latest = copy({ checkedAt: new Date(Date.now() - 91 * DAY) });
    const doc = await LawDocumentSvc.get(ACT, null);
    expect(doc?.body.toString()).to.equal("<html>live</html>");
    expect(saves).to.deep.equal([{ lawId: ACT.id, part: "", format: "html", previous: latest }]);
  });

  it("serves the old copy, marked stale, when legislation.gov.uk can't be reached", async () => {
    upstreamDown();
    latest = copy({ checkedAt: new Date(Date.now() - 91 * DAY) });
    const doc = await LawDocumentSvc.get(ACT, null);
    expect(doc?.body.toString()).to.equal("<html>saved</html>");
    expect(doc?.copy?.stale).to.equal(true);
  });

  it("returns null when legislation.gov.uk is down and nothing is saved", async () => {
    upstreamDown();
    expect(await LawDocumentSvc.get(ACT, null)).to.equal(null);
  });

  it("falls back to a live fetch when a fresh copy can't be read back", async () => {
    upstreamUp();
    latest = copy();
    patch([[LawDocumentCopyRepo, "findContent", async () => Buffer.from("not gzip")]]);
    const doc = await LawDocumentSvc.get(ACT, null);
    expect(doc?.body.toString()).to.equal("<html>live</html>");
  });

  it("never asks legislation.gov.uk for a PDF, and never takes one as the Act", async () => {
    const calls: string[] = [];
    patch([
      [
        globalThis,
        "fetch",
        async (url: string) => {
          calls.push(url);
          return new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } });
        },
      ],
    ]);
    expect(await LawDocumentSvc.get(ACT, null)).to.equal(null);
    expect(calls).to.deep.equal(["https://www.legislation.gov.uk/ukpga/2010/15/data.html"]);
    expect(saves).to.deep.equal([]);
  });

  it("serves judgments live and never looks for a copy", async () => {
    patch([
      [
        globalThis,
        "fetch",
        async () => new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }),
      ],
    ]);
    const doc = await LawDocumentSvc.get(JUDGMENT, null);
    expect(doc?.format).to.equal("pdf");
    expect(lookups).to.equal(0);
    expect(saves).to.deep.equal([]);
  });
});

describe("LawDocumentSvc.save", () => {
  let created: any[];
  let checked: string[];

  beforeEach(() => {
    created = [];
    checked = [];
    patch([
      [LawDocumentCopyRepo, "create", async (data: unknown) => created.push(data)],
      [LawDocumentCopyRepo, "markChecked", async (id: string) => checked.push(id)],
    ]);
  });

  afterEach(restoreAll);

  const doc = { body: Buffer.from("<html>v2</html>"), format: "html" as const, sourceUrl: "https://www.legislation.gov.uk/ukpga/2010/15/data.html" };

  it("keeps a new version of the HTML gzip-compressed in the row", async () => {
    await LawDocumentSvc.save("law-1", "section/29", doc, null);
    const row = created[0];
    expect(row).to.include({ lawId: "law-1", part: "section/29", bytes: doc.body.length, sourceUrl: doc.sourceUrl });
    expect(row).to.not.have.property("format");
    expect(row.sha256).to.match(/^[0-9a-f]{64}$/);
    expect(gunzipSync(row.content).toString()).to.equal("<html>v2</html>");
    expect(checked).to.deep.equal([]);
  });

  it("only moves checkedAt when legislation.gov.uk served the same HTML again", async () => {
    await LawDocumentSvc.save("law-1", "", doc, null);
    const previous = copy({ sha256: created[0].sha256 });
    created = [];
    await LawDocumentSvc.save("law-1", "", doc, previous);
    expect(created).to.deep.equal([]);
    expect(checked).to.deep.equal([previous.id]);
  });

  it("adds a row, without touching the old one, when the HTML changed", async () => {
    await LawDocumentSvc.save("law-1", "", doc, copy({ sha256: "something-else" }));
    expect(created).to.have.length(1);
    expect(checked).to.deep.equal([]);
  });

  it("keeps nothing past the size cap", async () => {
    await LawDocumentSvc.save("law-1", "", { ...doc, body: Buffer.alloc(MAX_COPY_BYTES + 1) }, null);
    expect(created).to.deep.equal([]);
  });

  it("never keeps a PDF", async () => {
    await LawDocumentSvc.save("law-1", "", { ...doc, format: "pdf" }, null);
    expect(created).to.deep.equal([]);
  });

  it("names parts the way the viewer asks for them", () => {
    expect(copyPart(null)).to.equal("");
    expect(copyPart("29A")).to.equal("section/29A");
  });
});

describe("LawDocumentSvc — retained EU law", () => {
  const UK_GDPR = { id: "law-3", jurisUrl: "https://www.legislation.gov.uk/eur/2016/679", pdfUrl: null } as Law;
  let saves: { lawId: string; part: string }[];

  beforeEach(() => {
    saves = [];
    patch([
      [LawDocumentCopyRepo, "findLatest", async () => null],
      [LawDocumentSvc, "save", async (lawId: string, part: string) => saves.push({ lawId, part })],
    ]);
  });

  afterEach(restoreAll);

  it("opens an EU regulation instead of answering 'No PDF available', and keeps a copy", async () => {
    const calls = upstreamUp();
    const doc = await LawDocumentSvc.get(UK_GDPR, null);
    expect(doc?.format).to.equal("html");
    expect(calls).to.deep.equal(["https://www.legislation.gov.uk/eur/2016/679/data.html"]);
    expect(saves).to.deep.equal([{ lawId: "law-3", part: "" }]);
  });

  it("asks for an article, not a section, when one is cited", async () => {
    const calls = upstreamUp();
    await LawDocumentSvc.get(UK_GDPR, "6");
    expect(calls).to.deep.equal(["https://www.legislation.gov.uk/eur/2016/679/article/6/data.html"]);
  });
});
