/** Consent is enforced where the purpose applies: an AI action needs AI_PROCESSING not to be
 * withdrawn. No live Postgres: the repo is monkeypatched on its CommonJS module object, same idiom
 * as test/consent-service.spec.ts. */
import fs from "fs";
import path from "path";
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ConsentSvc from "../src/services/consent.service";
import ConsentRepo from "../src/repositories/consent.repository";
import requireConsent from "../src/middleware/require-consent.middleware";
import HttpError from "../src/utils/http-error";

describe("ConsentSvc.isAllowed", () => {
  const original = ConsentRepo.find;
  let row: { withdrawnAt: Date | null } | null;

  beforeEach(() => {
    row = null;
    (ConsentRepo as any).find = async () => row;
  });
  afterEach(() => {
    (ConsentRepo as any).find = original;
  });

  it("lets AI work go ahead for someone who has never answered, so existing accounts keep working", async () => {
    expect(await ConsentSvc.isAllowed("u1", "AI_PROCESSING")).to.equal(true);
  });

  it("blocks a purpose the product does not use, so nothing can start on one by accident", async () => {
    expect(await ConsentSvc.isAllowed("u1", "ANALYTICS")).to.equal(false);
    expect(await ConsentSvc.isAllowed("u1", "MARKETING")).to.equal(false);
  });

  it("allows what was granted", async () => {
    row = { withdrawnAt: null };
    expect(await ConsentSvc.isAllowed("u1", "AI_PROCESSING")).to.equal(true);
  });

  it("blocks what was withdrawn, including AI work that is otherwise allowed by default", async () => {
    row = { withdrawnAt: new Date() };
    expect(await ConsentSvc.isAllowed("u1", "AI_PROCESSING")).to.equal(false);
  });

  it("never blocks on Terms of Service, which has no answer to withdraw here", async () => {
    row = { withdrawnAt: new Date() };
    expect(await ConsentSvc.isAllowed("u1", "TERMS_OF_SERVICE")).to.equal(true);
  });

  it("refuses with a 403 and a code the app can recognise", async () => {
    row = { withdrawnAt: new Date() };
    let error: HttpError | undefined;
    try {
      await ConsentSvc.assertAllowed("u1", "AI_PROCESSING");
    } catch (err) {
      error = err as HttpError;
    }
    expect(error).to.be.instanceOf(HttpError);
    expect(error!.statusCode).to.equal(403);
    expect(error!.code).to.equal("CONSENT_REQUIRED");
  });
});

describe("requireConsent middleware", () => {
  const original = ConsentRepo.find;
  let seenUser: string | undefined;
  let row: { withdrawnAt: Date | null } | null;

  beforeEach(() => {
    row = null;
    seenUser = undefined;
    (ConsentRepo as any).find = async (userId: string) => {
      seenUser = userId;
      return row;
    };
  });
  afterEach(() => {
    (ConsentRepo as any).find = original;
  });

  const run = (userId: string) =>
    new Promise<unknown>((resolve) => {
      requireConsent("AI_PROCESSING")({ user: { userId } } as any, {} as any, (err?: unknown) => resolve(err));
    });

  it("passes the request on when the person has not withdrawn", async () => {
    expect(await run("u1")).to.equal(undefined);
    expect(seenUser).to.equal("u1");
  });

  it("stops it with a 403 when they have", async () => {
    row = { withdrawnAt: new Date() };
    const err = (await run("u1")) as HttpError;
    expect(err.statusCode).to.equal(403);
    expect(err.code).to.equal("CONSENT_REQUIRED");
  });
});

/** The rule that keeps this from rotting: every route whose controller starts AI work must carry
 * requireConsent. Read from source, so a new "Generate" button that forgets it fails here. */
describe("routes that start AI work", () => {
  const src = path.join(__dirname, "..", "src");
  const AI_TRIGGERS = ["AiGenerationQueue.enqueue", "enqueueChatGeneration", "ChatGenerationQueue.enqueue"];

  function aiRoutes() {
    const found: Array<{ route: string; guarded: boolean }> = [];
    const routeDir = path.join(src, "routes");
    for (const file of fs.readdirSync(routeDir).filter((f) => f.endsWith(".route.ts"))) {
      const text = fs.readFileSync(path.join(routeDir, file), "utf8").replace(/\r\n/g, "\n");
      const controllers: Record<string, string> = {};
      for (const m of text.matchAll(/import (\w+) from "\.\.\/controllers\/([\w.-]+)"/g)) controllers[m[1]!] = m[2]!;
      for (const m of text.matchAll(/router\.(post|put|patch|delete)\(\s*([\s\S]*?)\);/g)) {
        const args = m[2]!;
        const route = args.match(/^\s*(["'`][^"'`]*["'`])\s*,/)?.[1];
        const handler = [...args.matchAll(/(\w+Ctrl)\.(\w+)/g)].pop();
        if (!route || !handler || !controllers[handler[1]!]) continue;
        const controller = fs.readFileSync(path.join(src, "controllers", `${controllers[handler[1]!]}.ts`), "utf8");
        const start = controller.indexOf(`static async ${handler[2]}(`);
        if (start < 0) continue;
        const next = controller.indexOf("static async ", start + 10);
        const body = controller.slice(start, next < 0 ? undefined : next);
        if (AI_TRIGGERS.some((t) => body.includes(t))) {
          found.push({ route: `${m[1]!.toUpperCase()} ${file} ${route}`, guarded: args.includes('requireConsent("AI_PROCESSING")') });
        }
      }
    }
    return found;
  }

  it("finds them (so this check can't pass by finding nothing)", () => {
    expect(aiRoutes().length).to.be.greaterThan(15);
  });

  it("all require AI_PROCESSING consent", () => {
    const unguarded = aiRoutes().filter((r) => !r.guarded).map((r) => r.route);
    expect(unguarded, `these start AI work without requireConsent("AI_PROCESSING"):\n${unguarded.join("\n")}`).to.deep.equal([]);
  });
});
