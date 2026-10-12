/** #407: every Jev call goes through jevAsk (src/utils/typesafeClient.ts), so model pinning, the
 * time limit, logging and usage recording apply to all of them. Fails if a module calls the SDK
 * directly or builds its own client. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const SRC = join(__dirname, "..", "src");
const WRAPPER = join("utils", "typesafeClient.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("Jev calls go through jevAsk", () => {
  it("no module outside typesafeClient.ts calls systemOne or builds a TypeSafeClient", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => relative(SRC, path) !== WRAPPER)
      .filter((path) => /\.systemOne\s*\(|new\s+TypeSafeClient\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).split(sep).join("/"));

    expect(offenders, "call jevAsk(feature, { state, questions }) instead").to.deep.equal([]);
  });
});
