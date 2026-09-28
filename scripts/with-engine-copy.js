/**
 * Runs a command with Prisma's query engine loaded from a private copy.
 *
 * Why: on Windows a loaded DLL can't be overwritten, so `prisma generate` / `migrate dev` fail with
 * `EPERM: operation not permitted, rename ...query_engine-windows.dll.node.tmpNNN` for as long as
 * the dev server (or a stuck test run) has the engine loaded from node_modules/.prisma/client.
 * PRISMA_QUERY_ENGINE_LIBRARY points the client at a copy instead, so the original stays
 * unlocked and Prisma commands can run while the server is up. (The server still needs a restart
 * to pick up a regenerated client — this only removes the file lock.)
 *
 * Usage: node scripts/with-engine-copy.js <command...>
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const clientDir = path.join(root, "node_modules", ".prisma", "client");
const copyDir = path.join(root, ".prisma-engine");

function findEngine() {
  if (!fs.existsSync(clientDir)) return null;
  const name = fs.readdirSync(clientDir).find((f) => /query_engine.*\.node$/.test(f) && !/\.tmp\d*$/.test(f));
  return name ? path.join(clientDir, name) : null;
}

function prepareCopy() {
  const source = findEngine();
  if (!source) return null;
  fs.mkdirSync(copyDir, { recursive: true });
  // Best-effort cleanup of earlier copies; one still loaded by a live process is locked, so skip it.
  for (const old of fs.readdirSync(copyDir)) {
    try {
      fs.unlinkSync(path.join(copyDir, old));
    } catch {
      /* in use by another running dev server */
    }
  }
  const target = path.join(copyDir, `${Date.now()}-${path.basename(source)}`);
  fs.copyFileSync(source, target);
  return target;
}

const command = process.argv.slice(2).join(" ");
if (!command) {
  console.error("usage: node scripts/with-engine-copy.js <command...>");
  process.exit(2);
}

const env = { ...process.env };
try {
  const copy = prepareCopy();
  if (copy) env.PRISMA_QUERY_ENGINE_LIBRARY = copy;
  else console.warn("[with-engine-copy] no Prisma engine found; run `npm run prisma:generate` first. Starting without a copy.");
} catch (err) {
  console.warn("[with-engine-copy] could not copy the Prisma engine; starting without one:", err.message);
}

const child = spawn(command, { cwd: root, env, stdio: "inherit", shell: true });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
