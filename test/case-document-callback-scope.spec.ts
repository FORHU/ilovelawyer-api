/**
 * The GET /api/v1/case-document/* callbacks are guarded by one shared API key that knows nothing
 * about whose document is asked for. case-document-callback-scope.service remembers the ids
 * handed to Chat Wonder for a turn, and the callbacks refuse any other id.
 *
 * No Redis/DB: redis and the chunk service are monkeypatched, same idiom as the other specs.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { redis } from "../src/lib/redis";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import DocumentChunkCtrl from "../src/controllers/document-chunk.controller";
import {
  CALLBACK_SCOPE_TTL_S,
  callbackScopeMode,
  filterDocumentsInScope,
  isDocumentInScope,
  registerTurnDocuments,
} from "../src/services/case-document-callback-scope.service";

const HANDED_OUT = "b56af9c1-1119-4ebe-bca2-330bbf6ea759";
const GUESSED = "11111111-2222-4333-8444-555555555555";

describe("case document callback scope", () => {
  const originals = {
    markMany: redis.markMany,
    exists: redis.exists,
    listByDocument: DocumentChunkSvc.listByDocument,
    listByCaseOrConsultation: DocumentChunkSvc.listByCaseOrConsultation,
    mode: process.env.CASE_DOCUMENT_CALLBACK_SCOPE_MODE,
  };
  let store: Set<string>;
  let redisReady: boolean;
  let marked: { keys: string[]; ttl: number }[];

  beforeEach(() => {
    store = new Set();
    redisReady = true;
    marked = [];
    delete process.env.CASE_DOCUMENT_CALLBACK_SCOPE_MODE;
    redis.markMany = async (keys: string[], ttl: number) => {
      marked.push({ keys, ttl });
      keys.forEach((k) => store.add(k));
    };
    redis.exists = async (key: string) => (redisReady ? store.has(key) : null);
  });

  afterEach(() => {
    redis.markMany = originals.markMany;
    redis.exists = originals.exists;
    DocumentChunkSvc.listByDocument = originals.listByDocument;
    DocumentChunkSvc.listByCaseOrConsultation = originals.listByCaseOrConsultation;
    if (originals.mode === undefined) delete process.env.CASE_DOCUMENT_CALLBACK_SCOPE_MODE;
    else process.env.CASE_DOCUMENT_CALLBACK_SCOPE_MODE = originals.mode;
  });

  function fakeRes() {
    const res: any = { statusCode: 0, body: undefined };
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (body: unknown) => {
      res.body = body;
      return res;
    };
    return res;
  }

  it("registers exactly the ids handed to Chat Wonder, once each, with an expiry", async () => {
    await registerTurnDocuments([HANDED_OUT, HANDED_OUT, ""]);
    expect(marked).to.have.length(1);
    expect(marked[0].keys).to.have.length(1);
    expect(marked[0].ttl).to.equal(CALLBACK_SCOPE_TTL_S);
    expect(await isDocumentInScope(HANDED_OUT)).to.equal(true);
  });

  it("registering nothing (a turn with no documents) writes nothing", async () => {
    await registerTurnDocuments([]);
    expect(marked).to.have.length(0);
  });

  it("refuses an id no turn handed out", async () => {
    await registerTurnDocuments([HANDED_OUT]);
    expect(await isDocumentInScope(GUESSED)).to.equal(false);
  });

  it("is case-insensitive about the id", async () => {
    await registerTurnDocuments([HANDED_OUT]);
    expect(await isDocumentInScope(HANDED_OUT.toUpperCase())).to.equal(true);
  });

  it("warn mode logs but allows; off mode allows; enforce (the default) refuses", async () => {
    expect(callbackScopeMode()).to.equal("enforce");
    process.env.CASE_DOCUMENT_CALLBACK_SCOPE_MODE = "warn";
    expect(callbackScopeMode()).to.equal("warn");
    expect(await isDocumentInScope(GUESSED)).to.equal(true);
    process.env.CASE_DOCUMENT_CALLBACK_SCOPE_MODE = "off";
    expect(await isDocumentInScope(GUESSED)).to.equal(true);
    process.env.CASE_DOCUMENT_CALLBACK_SCOPE_MODE = "nonsense";
    expect(callbackScopeMode()).to.equal("enforce");
    expect(await isDocumentInScope(GUESSED)).to.equal(false);
  });

  it("allows (and does not break chat) when Redis cannot be reached: an outage of the cache is not an outage of the callbacks", async () => {
    redisReady = false;
    expect(await isDocumentInScope(GUESSED)).to.equal(true);
  });

  it("GET /case-document/:id answers a not-handed-out id exactly like a missing document (404), and never reads it", async () => {
    let read = false;
    DocumentChunkSvc.listByDocument = (async () => {
      read = true;
      return {} as any;
    }) as any;
    let err: any;
    try {
      await DocumentChunkCtrl.list({ params: { caseDocumentId: GUESSED }, query: {} } as any, fakeRes());
    } catch (e) {
      err = e;
    }
    expect(err?.message).to.equal("Case document not found");
    expect(err?.statusCode ?? err?.status).to.equal(404);
    expect(read).to.equal(false);
  });

  it("GET /case-document/:id still serves an id that was handed to Chat Wonder", async () => {
    await registerTurnDocuments([HANDED_OUT]);
    DocumentChunkSvc.listByDocument = (async () => ({ caseDocumentId: HANDED_OUT, chunks: [] })) as any;
    const res = fakeRes();
    await DocumentChunkCtrl.list({ params: { caseDocumentId: HANDED_OUT }, query: {} } as any, res);
    expect(res.statusCode).to.equal(200);
    expect(res.body.caseDocumentId).to.equal(HANDED_OUT);
  });

  it("the by-case / by-consultation list only returns documents handed out", async () => {
    await registerTurnDocuments([HANDED_OUT]);
    DocumentChunkSvc.listByCaseOrConsultation = (async () => [
      { caseDocumentId: HANDED_OUT, name: "a", chunks: [] },
      { caseDocumentId: GUESSED, name: "b", chunks: [] },
    ]) as any;
    const res = fakeRes();
    await DocumentChunkCtrl.listByFilter({ query: { caseId: "c1" } } as any, res);
    expect(res.body.map((d: any) => d.caseDocumentId)).to.deep.equal([HANDED_OUT]);
  });

  it("filterDocumentsInScope keeps order and drops only what is out of scope", async () => {
    await registerTurnDocuments([HANDED_OUT]);
    const kept = await filterDocumentsInScope(
      [{ id: GUESSED }, { id: HANDED_OUT }, { id: GUESSED }],
      (x) => x.id,
    );
    expect(kept).to.deep.equal([{ id: HANDED_OUT }]);
  });
});
