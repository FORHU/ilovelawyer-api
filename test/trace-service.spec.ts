import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import CaseAccess from "../src/utils/case-access";
import TraceRepo from "../src/repositories/trace.repository";
import TraceSvc from "../src/services/trace.service";

const at = (iso: string) => new Date(iso);

// Newest first, as the repository returns them: t3 (Bo), t2 (Ana), t1 (Ana).
const headers = [
  { turnId: "t3", userId: "bo", firstSeq: 30, startedAt: at("2026-10-03T12:00:00Z"), eventCount: 4 },
  { turnId: "t2", userId: "ana", firstSeq: 20, startedAt: at("2026-10-03T11:00:00Z"), eventCount: 2 },
  { turnId: "t1", userId: "ana", firstSeq: 10, startedAt: at("2026-10-03T10:00:00Z"), eventCount: 3 },
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
        ["t3", "Summarise the lease"],
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

  it("lists turns oldest first, numbered, each with who asked and what", async () => {
    const turns = await TraceSvc.listTurns("case-1", "caller");
    expect(turns.map((t) => [t.number, t.turnId, t.userName])).to.deep.equal([
      [1, "t1", "Ana Cruz"],
      [2, "t2", "Ana Cruz"],
      [3, "t3", null], // Bo has no name on record: the pane shows "Former member"
    ]);
    expect(turns[0].title).to.equal("What is the notice period?");
  });

  it("keeps a turn's number when filtered to one member", async () => {
    const turns = await TraceSvc.listTurns("case-1", "caller", "bo");
    expect(turns.map((t) => [t.number, t.turnId])).to.deep.equal([[3, "t3"]]);
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
