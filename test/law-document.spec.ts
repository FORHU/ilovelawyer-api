/** LawDocumentSvc — the Library viewer's document source, with our own copies of UK legislation
 * (gzip-compressed in Postgres) behind UK_LEGISLATION_COPIES. No live Postgres or legislation.gov.uk:
 * the repository and global fetch are monkeypatched. */
import { gunzipSync, gzipSync } from "zlib";
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import type { Law } from "@prisma/client";
import LawDocumentSvc, { MAX_COPY_BYTES, copiesMode, copyPart } from "../src/services/law-document.service";
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
  for (const [key, value] of envRestores.splice(0)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// process.env turns an assigned `undefined` into the string "undefined", so it gets its own helper.
const envRestores: [string, string | undefined][] = [];
function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    envRestores.push([key, process.env[key]]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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
    format: "html",
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

describe("LawDocumentSvc", () => {
  let saves: { lawId: string; part: string; previous: LawDocumentCopyMeta | null }[];
  let latest: LawDocumentCopyMeta | null;
  let lookups: number;

  beforeEach(() => {
    saves = [];
    latest = null;
    lookups = 0;
    setEnv({ UK_LEGISLATION_COPIES: undefined, UK_LEGISLATION_COPY_TTL_DAYS: undefined });
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
        async (lawId: string, part: string, _doc: unknown, previous: LawDocumentCopyMeta | null) => {
          saves.push({ lawId, part, previous });
        },
      ],
      [LawDocumentCopyRepo, "findContent", async () => gzipSync(Buffer.from("<html>saved</html>"))],
    ]);
  });

  afterEach(restoreAll);

  describe("copiesMode", () => {
    it("is off unless set to store or serve", () => {
      expect(copiesMode()).to.equal("off");
      setEnv({ UK_LEGISLATION_COPIES: "yes" });
      expect(copiesMode()).to.equal("off");
      setEnv({ UK_LEGISLATION_COPIES: " Serve " });
      expect(copiesMode()).to.equal("serve");
    });
  });

  describe("off (the default)", () => {
    it("fetches live, falls back from the refused PDF to HTML, and keeps nothing", async () => {
      const calls = upstreamUp();
      const doc = await LawDocumentSvc.get(ACT, "29");
      expect(doc?.format).to.equal("html");
      expect(doc?.body.toString()).to.equal("<html>live</html>");
      expect(doc?.copy).to.equal(undefined);
      expect(calls).to.deep.equal([
        "https://www.legislation.gov.uk/ukpga/2010/15/section/29/data.pdf",
        "https://www.legislation.gov.uk/ukpga/2010/15/section/29/data.html",
      ]);
      expect(lookups).to.equal(0);
      expect(saves).to.deep.equal([]);
    });

    it("returns null when upstream is down, even if a copy exists", async () => {
      upstreamDown();
      latest = copy();
      expect(await LawDocumentSvc.get(ACT, null)).to.equal(null);
    });
  });

  describe("serve", () => {
    beforeEach(() => {
      setEnv({ UK_LEGISLATION_COPIES: "serve" });
    });

    it("serves a fresh copy without calling upstream", async () => {
      noUpstream();
      latest = copy();
      const doc = await LawDocumentSvc.get(ACT, null);
      expect(doc?.body.toString()).to.equal("<html>saved</html>");
      expect(doc?.copy).to.deep.equal({ checkedAt: latest.checkedAt, stale: false });
      expect(saves).to.deep.equal([]);
    });

    it("fetches live once the copy is past the TTL, and saves the new version", async () => {
      setEnv({ UK_LEGISLATION_COPY_TTL_DAYS: "7" });
      upstreamUp();
      latest = copy();
      const doc = await LawDocumentSvc.get(ACT, null);
      expect(doc?.body.toString()).to.equal("<html>live</html>");
      expect(doc?.copy).to.equal(undefined);
      expect(saves).to.deep.equal([{ lawId: ACT.id, part: "", previous: latest }]);
    });

    it("serves the stale copy, marked stale, when upstream can't be reached", async () => {
      setEnv({ UK_LEGISLATION_COPY_TTL_DAYS: "7" });
      upstreamDown();
      latest = copy();
      const doc = await LawDocumentSvc.get(ACT, null);
      expect(doc?.body.toString()).to.equal("<html>saved</html>");
      expect(doc?.copy?.stale).to.equal(true);
    });

    it("fetches live and saves when there is no copy yet", async () => {
      upstreamUp();
      const doc = await LawDocumentSvc.get(ACT, "29");
      expect(doc?.body.toString()).to.equal("<html>live</html>");
      expect(saves).to.deep.equal([{ lawId: ACT.id, part: "section/29", previous: null }]);
    });

    it("falls back to a live fetch when a fresh copy can't be read back", async () => {
      upstreamUp();
      latest = copy();
      patch([[LawDocumentCopyRepo, "findContent", async () => Buffer.from("not gzip")]]);
      const doc = await LawDocumentSvc.get(ACT, null);
      expect(doc?.body.toString()).to.equal("<html>live</html>");
    });

    it("never copies anything but UK legislation", async () => {
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

  describe("store", () => {
    beforeEach(() => {
      setEnv({ UK_LEGISLATION_COPIES: "store" });
    });

    it("always serves live, and saves when there is no fresh copy", async () => {
      upstreamUp();
      const doc = await LawDocumentSvc.get(ACT, null);
      expect(doc?.copy).to.equal(undefined);
      expect(saves).to.have.length(1);
    });

    it("doesn't save again while the copy is fresh", async () => {
      upstreamUp();
      latest = copy();
      const doc = await LawDocumentSvc.get(ACT, null);
      expect(doc?.body.toString()).to.equal("<html>live</html>");
      expect(saves).to.deep.equal([]);
    });

    it("never serves the copy, even when upstream is down", async () => {
      upstreamDown();
      latest = copy();
      expect(await LawDocumentSvc.get(ACT, null)).to.equal(null);
    });
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
  const sha256 = "a0a38b1c21c7d9cf8b3d8f2f02b9cbb9c3a1c39b0a3bd1d1e5d0d2a2d4f2e7f1";

  it("keeps a new version gzip-compressed in the row, with no File", async () => {
    await LawDocumentSvc.save("law-1", "section/29", doc, null);
    const row = created[0];
    expect(row).to.include({ lawId: "law-1", part: "section/29", format: "html", bytes: doc.body.length, sourceUrl: doc.sourceUrl });
    expect(row.sha256).to.match(/^[0-9a-f]{64}$/);
    expect(gunzipSync(row.content).toString()).to.equal("<html>v2</html>");
    expect(row).to.not.have.property("fileId");
    expect(checked).to.deep.equal([]);
  });

  it("only moves checkedAt when upstream served the same bytes again", async () => {
    await LawDocumentSvc.save("law-1", "", doc, null);
    const previous = copy({ sha256: created[0].sha256, format: "html" });
    created = [];
    await LawDocumentSvc.save("law-1", "", doc, previous);
    expect(created).to.deep.equal([]);
    expect(checked).to.deep.equal([previous.id]);
  });

  it("adds a row, without touching the old one, when the document changed", async () => {
    await LawDocumentSvc.save("law-1", "", doc, copy({ sha256 }));
    expect(created).to.have.length(1);
    expect(checked).to.deep.equal([]);
  });

  it("keeps nothing past the size cap", async () => {
    await LawDocumentSvc.save("law-1", "", { ...doc, body: Buffer.alloc(MAX_COPY_BYTES + 1) }, null);
    expect(created).to.deep.equal([]);
  });
});

describe("LawDocumentSvc.copiesFor", () => {
  afterEach(restoreAll);

  it("reports nothing outside serve mode, without a query", async () => {
    setEnv({ UK_LEGISLATION_COPIES: "store" });
    patch([
      [
        LawDocumentCopyRepo,
        "listLatestByLaw",
        async () => {
          throw new Error("must not query");
        },
      ],
    ]);
    expect(await LawDocumentSvc.copiesFor(ACT)).to.deep.equal([]);
  });

  it("lists each part's latest copy with its freshness in serve mode", async () => {
    const recent = new Date(Date.now() - DAY);
    const old = new Date(Date.now() - 200 * DAY);
    setEnv({ UK_LEGISLATION_COPIES: "serve", UK_LEGISLATION_COPY_TTL_DAYS: undefined });
    patch([
      [
        LawDocumentCopyRepo,
        "listLatestByLaw",
        async () => [copy({ part: "", checkedAt: recent }), copy({ part: "section/29", checkedAt: old })],
      ],
    ]);
    expect(await LawDocumentSvc.copiesFor(ACT)).to.deep.equal([
      { part: "", checked_at: recent.toISOString(), fresh: true },
      { part: "section/29", checked_at: old.toISOString(), fresh: false },
    ]);
  });

  it("names parts the way the viewer asks for them", () => {
    expect(copyPart(null)).to.equal("");
    expect(copyPart("29A")).to.equal("section/29A");
  });

});
