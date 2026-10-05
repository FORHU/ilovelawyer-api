import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import CaseAccess from "../src/utils/case-access";
import TraceRepo from "../src/repositories/trace.repository";
import TraceSvc from "../src/services/trace.service";

const at = (iso: string) => new Date(iso);

// Newest first, as the repository returns them: a witness scoring run (Bo) after two chat
// questions (Ana), then a second chat question (Bo), then a first scoring run (Ana).
const headers = [
  { turnId: "t5", source: "witnessScoring", userId: "ana", firstSeq: 50, startedAt: at("2026-10-03T14:00:00Z"), eventCount: 5 },
  { turnId: "t4", source: "chat", userId: "bo", firstSeq: 40, startedAt: at("2026-10-03T13:00:00Z"), eventCount: 1 },
  { turnId: "t3", source: "witnessScoring", userId: "bo", firstSeq: 30, startedAt: at("2026-10-03T12:00:00Z"), eventCount: 4 },
  { turnId: "t2", source: "chat", userId: "ana", firstSeq: 20, startedAt: at("2026-10-03T11:00:00Z"), eventCount: 2 },
  { turnId: "t1", source: "chat", userId: "ana", firstSeq: 10, startedAt: at("2026-10-03T10:00:00Z"), eventCount: 3 },
];

describe("TraceSvc", () => {
  const real = {
    load: CaseAccess.loadAccessibleCase,
    headers: TraceRepo.listTurnHeaders,
    events: TraceRepo.listTurnEvents,
    prompts: TraceRepo.promptsByMessageId,
    names: TraceRepo.namesByUserId,
  };
  let repoCalls: string[];
  let denied: boolean;

  beforeEach(() => {
    repoCalls = [];
    denied = false;
    (CaseAccess as any).loadAccessibleCase = async () => {
      if (denied) throw new Error("no access");
      return { id: "case-1" };
    };
    (TraceRepo as any).listTurnHeaders = async () => (repoCalls.push("headers"), headers);
    (TraceRepo as any).listTurnEvents = async () => (repoCalls.push("events"), []);
    (TraceRepo as any).promptsByMessageId = async () =>
      new Map([
        ["t1", "What is the notice period?"],
        ["t2", "Draft a demand letter"],
        ["t4", "Summarise the lease"],
        ["t3", "NOT A QUESTION: a scoring run is not a Message"],
      ]);
    (TraceRepo as any).namesByUserId = async () => new Map<string, string | null>([["ana", "Ana Cruz"]]);
  });

  afterEach(() => {
    (CaseAccess as any).loadAccessibleCase = real.load;
    (TraceRepo as any).listTurnHeaders = real.headers;
    (TraceRepo as any).listTurnEvents = real.events;
    (TraceRepo as any).promptsByMessageId = real.prompts;
    (TraceRepo as any).namesByUserId = real.names;
  });

  it("lists runs oldest first, each named by its source and numbered within it", async () => {
    const turns = await TraceSvc.listTurns("case-1", "caller");
    expect(turns.map((t) => [t.turnId, t.source, t.number])).to.deep.equal([
      ["t1", "chat", 1],
      ["t2", "chat", 2],
      ["t3", "witnessScoring", 1],
      ["t4", "chat", 3],
      ["t5", "witnessScoring", 2],
    ]);
  });

  it("shows the question for a chat run, and none for a pane's generation", async () => {
    const turns = await TraceSvc.listTurns("case-1", "caller");
    const byId = new Map(turns.map((t) => [t.turnId, t]));
    expect(byId.get("t1")!.title).to.equal("What is the notice period?");
    expect(byId.get("t3")!.title).to.equal(null);
  });

  it("only looks up questions for the chat runs", async () => {
    let asked: string[] = [];
    (TraceRepo as any).promptsByMessageId = async (ids: string[]) => ((asked = ids), new Map());
    await TraceSvc.listTurns("case-1", "caller");
    expect(asked.sort()).to.deep.equal(["t1", "t2", "t4"]);
  });

  it("says who triggered each run", async () => {
    const turns = await TraceSvc.listTurns("case-1", "caller");
    expect(turns.map((t) => [t.turnId, t.userName])).to.deep.equal([
      ["t1", "Ana Cruz"],
      ["t2", "Ana Cruz"],
      ["t3", null], // Bo has no name on record: the pane shows "Former member"
      ["t4", null],
      ["t5", "Ana Cruz"],
    ]);
  });

  it("keeps a run's number when filtered to one member", async () => {
    const turns = await TraceSvc.listTurns("case-1", "caller", "bo");
    expect(turns.map((t) => [t.turnId, t.source, t.number])).to.deep.equal([
      ["t3", "witnessScoring", 1],
      ["t4", "chat", 3],
    ]);
  });

  it("checks case access before reading anything", async () => {
    denied = true;
    let error: Error | undefined;
    await TraceSvc.listTurns("case-1", "caller").catch((e) => (error = e));
    expect(error?.message).to.equal("no access");
    expect(repoCalls).to.deep.equal([]);
  });

  it("checks case access before reading a turn's events", async () => {
    denied = true;
    let error: Error | undefined;
    await TraceSvc.listTurnEvents("case-1", "caller", "t1").catch((e) => (error = e));
    expect(error?.message).to.equal("no access");
    expect(repoCalls).to.deep.equal([]);
  });
});
