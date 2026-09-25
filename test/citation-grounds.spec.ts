/** Citation Map authority → claim links: parsing the mapping reply, Jev's check of a link
 * (USE_JEV_CITATION_GROUNDS), and CitationGroundSvc.verify dropping the links Jev reads as not
 * applying. No live Jev — the TypeSafe client is monkeypatched, same idiom as
 * contradiction-triage.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { extractCitationGrounds } from "../src/utils/citation-grounds-parse";
import { checkCitationGroundWithJev } from "../src/utils/citation-ground-jev";
import CitationGroundSvc from "../src/services/citation-ground.service";

const citations = new Set(["cc1", "cc2"]);
const claims = new Set(["cl1", "cl2"]);
const reply = (rows: unknown[]) => `[GROUNDS]\n${JSON.stringify(rows)}\n[/GROUNDS]`;

describe("extractCitationGrounds", () => {
  it("keeps links between known ids with a known role, once per pair", () => {
    const found = extractCitationGrounds(
      reply([
        { citationId: "cc1", claimId: "cl1", role: "substantive", reason: "States the just causes for dismissal" },
        { citationId: "cc1", claimId: "cl1", role: "PROCEDURAL" },
        { citationId: "cc2", claimId: "cl2", role: "PROCEDURAL" },
      ]),
      citations,
      claims,
    );
    expect(found).to.deep.equal([
      { citationCheckId: "cc1", claimId: "cl1", role: "SUBSTANTIVE", reason: "States the just causes for dismissal" },
      { citationCheckId: "cc2", claimId: "cl2", role: "PROCEDURAL", reason: null },
    ]);
  });

  it("drops unknown ids and roles, and returns undefined with no block", () => {
    const found = extractCitationGrounds(
      reply([
        { citationId: "cc9", claimId: "cl1", role: "SUBSTANTIVE" },
        { citationId: "cc1", claimId: "cl9", role: "SUBSTANTIVE" },
        { citationId: "cc1", claimId: "cl1", role: "MAYBE" },
      ]),
      citations,
      claims,
    );
    expect(found).to.deep.equal([]);
    expect(extractCitationGrounds("nothing", citations, claims)).to.equal(undefined);
  });
});

describe("Citation ground Jev check", () => {
  const original = TypeSafeClient.prototype.systemOne;
  const flag = process.env.USE_JEV_CITATION_GROUNDS;
  let replies: Record<string, unknown>;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    replies = {};
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: { authority: { reference: string } } }) => {
      const r = replies[req.state.authority.reference];
      if (r instanceof Error) throw r;
      return r;
    };
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
    if (flag === undefined) delete process.env.USE_JEV_CITATION_GROUNDS;
    else process.env.USE_JEV_CITATION_GROUNDS = flag;
  });
  const answer = (choice: string, confidence: number) => ({ answers: { attaches: { choice, confidence } } });
  const input = (reference: string) => ({
    authority: { reference, title: null, quotedText: "No employee shall be dismissed except for a just cause", officialText: null },
    claim: { title: "Illegal dismissal", causeOfAction: null, description: null },
    role: "SUBSTANTIVE" as const,
  });

  it("reports an unsure DOES_NOT_APPLY as TANGENTIAL", async () => {
    replies["Art. 297"] = answer("DOES_NOT_APPLY", 0.6);
    expect(await checkCitationGroundWithJev(input("Art. 297"))).to.deep.equal({ attaches: "TANGENTIAL", confidence: 0.6 });
    replies["Art. 297"] = answer("DOES_NOT_APPLY", 0.8);
    expect((await checkCitationGroundWithJev(input("Art. 297"))).attaches).to.equal("DOES_NOT_APPLY");
  });

  it("verify drops links Jev reads as not applying, keeps failed checks unchecked, and passes everything through with the flag off", async () => {
    const check = (id: string, reference: string) =>
      ({ id, citedReference: reference, quotedText: "…", officialText: null, resolvedLawId: null }) as any;
    const claim = { id: "cl1", title: "Illegal dismissal", causeOfAction: null, description: null } as any;
    const checks = [check("cc1", "Art. 297"), check("cc2", "Agabon"), check("cc3", "Abbott Labs")];
    const proposed = ["cc1", "cc2", "cc3"].map((id) => ({ citationCheckId: id, claimId: "cl1", role: "SUBSTANTIVE" as const, reason: null }));
    replies["Art. 297"] = answer("SUPPORTS_GROUND", 0.9);
    replies.Agabon = answer("DOES_NOT_APPLY", 0.9);
    replies["Abbott Labs"] = new Error("Jev down");

    process.env.USE_JEV_CITATION_GROUNDS = "false";
    expect(await CitationGroundSvc.verify(proposed, checks, [claim], new Map())).to.have.length(3);

    process.env.USE_JEV_CITATION_GROUNDS = "true";
    const rows = await CitationGroundSvc.verify(proposed, checks, [claim], new Map());
    expect(rows.map((r) => r.citationCheckId)).to.deep.equal(["cc1", "cc3"]);
    expect((rows[0].jev as any).attaches).to.equal("SUPPORTS_GROUND");
    expect(rows[1].jev).to.equal(undefined);
  });
});
