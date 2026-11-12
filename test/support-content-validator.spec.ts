/** Support Chat content validation (validateSupportContent): what Publish refuses. Pure, no database. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { validateSupportContent } from "../src/services/support-content-validator";
import { supportContentSchema } from "../src/validation/support-content.validation";
import { SUPPORT_CONTENT_V1 } from "../src/constants/support-content-seed";
import { SUPPORT_ACTIONS } from "../src/constants/support-actions.constants";
import type { SupportContent } from "../src/types/support-content";

const fresh = (): SupportContent => JSON.parse(JSON.stringify(SUPPORT_CONTENT_V1));
const codes = (content: SupportContent) => validateSupportContent(content).map((p) => p.code);
const problem = (content: SupportContent, code: string) => validateSupportContent(content).find((p) => p.code === code);

describe("Support content validation", () => {
  it("accepts the bundled seed, and the seed has the shape the schema wants", () => {
    expect(validateSupportContent(SUPPORT_CONTENT_V1)).to.deep.equal([]);
    expect(supportContentSchema.validate(SUPPORT_CONTENT_V1).error).to.equal(undefined);
  });

  it("seeds every flow the issue lists, on the right menu", () => {
    const signedIn = SUPPORT_CONTENT_V1.menus.SIGNED_IN.map((c) => c.title);
    expect(signedIn).to.deep.equal(["Getting started", "Credits & payments", "My lawyer request", "Account & sign-in", "Report an issue"]);
    expect(SUPPORT_CONTENT_V1.menus.SIGNED_OUT).to.have.length(5);
    expect(Object.keys(SUPPORT_CONTENT_V1.flows)).to.include.members([
      "credits-how", "credits-ran-out", "topup-missing", "promo", "refund", "pay-quote",
      "request-status", "request-expired", "request-withdraw", "request-end", "lawyer-complaint",
      "change-password", "export-data", "delete-account", "report-issue", "legal-question",
      "so-cant-sign-in", "so-no-code", "so-forgot-password", "so-cancel-deletion", "so-something-else",
    ]);
  });

  it("sends the refund, disputed charge, bug report and lawyer complaint flows straight to a person", () => {
    for (const id of ["refund", "disputed-charge", "report-issue", "lawyer-complaint"]) {
      const start = SUPPORT_CONTENT_V1.flows[id].steps.start;
      expect(start.type).to.equal("CHOICES");
      if (start.type === "CHOICES") expect(start.options.some((o) => o.target.kind === "TALK_TO_PERSON")).to.equal(true);
    }
  });

  it("points legal questions at the case's AI chat and never answers them", () => {
    const flow = SUPPORT_CONTENT_V1.flows["legal-question"];
    expect(flow.triggers).to.include.members(["can i sue", "my rights"]);
    expect(SUPPORT_CONTENT_V1.menus.SIGNED_IN.some((c) => c.flowId === "legal-question")).to.equal(false);
  });

  it("refuses a step nothing leads to", () => {
    const content = fresh();
    content.flows["credits-how"].steps.orphan = { id: "orphan", type: "MESSAGE", text: "Nobody gets here" };
    expect(problem(content, "STEP_UNREACHABLE")?.path).to.equal("flows.credits-how.steps.orphan");
  });

  it("refuses a button that points to a missing step or flow", () => {
    const content = fresh();
    const hub = content.flows["credits-payments"].steps.start;
    if (hub.type !== "CHOICES") throw new Error("seed changed");
    hub.options[0].target = { kind: "STEP", stepId: "nope" };
    hub.options[1].target = { kind: "FLOW", flowId: "nope" };
    const found = validateSupportContent(content);
    expect(found.find((p) => p.code === "TARGET_STEP_MISSING")?.path).to.equal("flows.credits-payments.steps.start.options[0].target");
    expect(found.find((p) => p.code === "TARGET_FLOW_MISSING")?.path).to.equal("flows.credits-payments.steps.start.options[1].target");
  });

  it("refuses a missing start step, a missing related flow and a menu card with no flow", () => {
    const content = fresh();
    content.flows.promo.startStepId = "nope";
    content.flows.promo.relatedFlowIds = ["nope"];
    content.menus.SIGNED_IN[0].flowId = "nope";
    expect(codes(content)).to.include.members(["START_STEP_MISSING", "TARGET_FLOW_MISSING", "MENU_FLOW_MISSING"]);
  });

  it("refuses an action that isn't in the catalog", () => {
    const content = fresh();
    const step = content.flows["credits-how"].steps.check;
    if (step.type !== "ACTION") throw new Error("seed changed");
    (step as { actionKey: string }).actionKey = "REFUND_EVERYTHING";
    expect(codes(content)).to.include("UNKNOWN_ACTION");
  });

  it("refuses an account-reading action on a signed-out path", () => {
    const content = fresh();
    const flow = content.flows["so-forgot-password"];
    flow.steps.send = { id: "send", type: "ACTION", actionKey: "SHOW_CREDITS", onSuccess: { kind: "STEP", stepId: "sent" }, onFailure: { kind: "STEP", stepId: "fail" } };
    expect(SUPPORT_ACTIONS.SHOW_CREDITS.readsAccount).to.equal(true);
    expect(problem(content, "ACTION_AUDIENCE_MISMATCH")?.path).to.equal("flows.so-forgot-password.steps.send.actionKey");
  });

  it("refuses a flow for both audiences that uses an action only one can run", () => {
    const content = fresh();
    content.flows["credits-how"].audience = "BOTH";
    expect(codes(content)).to.include("ACTION_AUDIENCE_MISMATCH");
  });

  it("refuses a signed-out menu card for a signed-in flow, and a signed-out flow reaching a signed-in one", () => {
    const content = fresh();
    content.menus.SIGNED_OUT[0].flowId = "credits-how";
    content.flows["so-cant-sign-in"].relatedFlowIds = ["credits-how"];
    expect(codes(content)).to.include.members(["MENU_FLOW_AUDIENCE", "FLOW_AUDIENCE_MISMATCH"]);
  });

  it("allows {firstName} and no other placeholder", () => {
    const content = fresh();
    expect(codes(content)).to.not.include("UNKNOWN_PLACEHOLDER");
    content.settings.greeting = "Hi {firstName}, you have {credits} left";
    const found = problem(content, "UNKNOWN_PLACEHOLDER");
    expect(found?.path).to.equal("settings.greeting");
    expect(found?.message).to.include("{credits}");
  });

  it("allows https, mailto and in-app links and nothing else", () => {
    const content = fresh();
    const flow = content.flows["start-case"];
    const go = flow.steps.go;
    if (go.type !== "CHOICES") throw new Error("seed changed");
    for (const href of ["https://ilovelawyer.com/help", "mailto:help@ilovelawyer.com", "/cases/new"]) {
      go.options[0].target = { kind: "LINK", href };
      expect(codes(content), href).to.not.include("INVALID_LINK");
    }
    for (const href of ["javascript:alert(1)", "//evil.example", "/\\evil.example", "/path\\with-backslash", "http://plain.example", "ftp://x"]) {
      go.options[0].target = { kind: "LINK", href };
      expect(codes(content), href).to.include("INVALID_LINK");
    }
  });

  it("takes an https avatar or none, and nothing else", () => {
    const withAvatar = (avatarUrl: unknown) => supportContentSchema.validate({ ...fresh(), settings: { ...fresh().settings, avatarUrl } }).error;
    expect(withAvatar(null)).to.equal(undefined);
    expect(withAvatar("https://cdn.example.com/lexi.png")).to.equal(undefined);
    for (const bad of ["javascript:alert(1)", "http://cdn.example.com/lexi.png", "data:image/png;base64,AAAA", "/lexi.png", "lexi.png"]) {
      expect(withAvatar(bad), bad).to.not.equal(undefined);
    }
  });

  it("refuses a menu with nothing switched on, and duplicate card ids", () => {
    const content = fresh();
    for (const card of content.menus.SIGNED_OUT) card.enabled = false;
    content.menus.SIGNED_IN[1].id = content.menus.SIGNED_IN[0].id;
    expect(codes(content)).to.include.members(["EMPTY_MENU", "DUPLICATE_ID"]);
  });

  it("refuses ids that don't match their keys", () => {
    const content = fresh();
    content.flows.promo.id = "other";
    content.flows.promo.steps.start.id = "other";
    expect(codes(content)).to.include("ID_MISMATCH");
  });
});
