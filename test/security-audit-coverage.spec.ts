/** The guard that keeps security audit coverage from drifting back to opt-in
 * (docs/adr/0006-security-audit-log.md): every mutating route — and every GET that exports,
 * downloads or resolves a file — must be listed in test/support/security-audit-coverage.ts with
 * the actions it writes or the reason it writes none, and every action in the catalog must be
 * written somewhere in src/.
 */
import { expect } from "chai";
import { describe, it } from "mocha";
import fs from "fs";
import path from "path";
import router from "../src/routes";
import { SECURITY_AUDIT_ACTIONS } from "../src/constants/security-audit.constants";
import { SECURITY_AUDIT_COVERAGE } from "./support/security-audit-coverage";
import { listRoutes } from "./support/list-routes";

const MUST_CLASSIFY_GET = /export|download|resolve|csv/i;

function routesToClassify(): string[] {
  return listRoutes(router)
    .filter((r) => r.method !== "GET" || MUST_CLASSIFY_GET.test(r.path))
    .map((r) => `${r.method} ${r.path}`);
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("Security audit coverage", () => {
  it("classifies every mutating route (add new routes to test/support/security-audit-coverage.ts)", () => {
    const missing = routesToClassify().filter((route) => !(route in SECURITY_AUDIT_COVERAGE));
    expect(missing, `Routes with no security audit decision:\n  ${missing.join("\n  ")}\n`).to.deep.equal([]);
  });

  it("has no entries for routes that no longer exist", () => {
    const live = new Set(routesToClassify());
    const stale = Object.keys(SECURITY_AUDIT_COVERAGE).filter((route) => !live.has(route));
    expect(stale, `Stale coverage entries:\n  ${stale.join("\n  ")}\n`).to.deep.equal([]);
  });

  it("only names actions that are in the catalog, and gives every exemption a reason", () => {
    const catalog = new Set<string>(SECURITY_AUDIT_ACTIONS);
    for (const [route, entry] of Object.entries(SECURITY_AUDIT_COVERAGE)) {
      if (Array.isArray(entry)) {
        expect(entry, route).to.not.be.empty;
        for (const action of entry) expect(catalog.has(action), `${route}: unknown action ${action}`).to.equal(true);
      } else {
        expect((entry as { exempt: string }).exempt, route).to.be.a("string").and.not.be.empty;
      }
    }
  });

  it("writes every catalog action somewhere in src/", () => {
    const srcDir = path.join(__dirname, "..", "src");
    const catalogFile = path.join(srcDir, "constants", "security-audit.constants.ts");
    const source = sourceFiles(srcDir)
      .filter((file) => file !== catalogFile)
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const neverWritten = SECURITY_AUDIT_ACTIONS.filter((action) => !source.includes(`"${action}"`));
    expect(neverWritten, "Actions in the catalog that no code writes").to.deep.equal([]);
  });
});
