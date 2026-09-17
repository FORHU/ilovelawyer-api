/**
 * Verifies the local bench API serves the Brackenmoor documents to chat-wonder's credentials,
 * so get_case_document won't 401/404 mid-run. Reads the key chat-wonder itself uses and sends
 * it as x-api-key; the key value is never printed.
 */
require("dotenv").config();
const fs = require("fs");
const http = require("http");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const CASE_ID = "8aedbceb-aa41-467f-88f1-9b4601db644b";
const PORT = Number(process.env.BENCH_API_PORT || 3999);
const ENV_PATH =
  "C:/Users/User/Documents/forhu-project/chat-wonder-v2-api/resources/functions/user_functions.env";

function chatWonderKey() {
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const m = /^CHAT_WONDER_API_KEY=(.*)$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return "";
}

function get(path, key) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "GET", headers: { "x-api-key": key } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    req.end();
  });
}

async function main() {
  const key = chatWonderKey();
  if (!key) throw new Error("no CHAT_WONDER_API_KEY found in chat-wonder user_functions.env");

  const doc = await prisma.document.findFirst({
    where: { caseId: CASE_ID, name: { startsWith: "D20" } },
    select: { id: true, name: true },
  });

  const unauth = await get(`/api/v1/case-document/${doc.id}`, "wrong-key");
  const res = await get(`/api/v1/case-document/${doc.id}`, key);

  let summary = { parseError: res.body.slice(0, 200) };
  if (res.status === 200) {
    const json = JSON.parse(res.body);
    const chunks = json.chunks || [];
    summary = {
      name: json.name,
      ragStatus: json.ragStatus,
      chunks: chunks.length,
      totalChars: chunks.reduce((n, c) => n + (c.chunkText || "").length, 0),
      hasEmbeddingField: Object.prototype.hasOwnProperty.call(chunks[0] || {}, "embedding"),
      chunkKeys: Object.keys(chunks[0] || {}),
    };
  }

  console.log(
    JSON.stringify(
      {
        document: doc.name,
        authRejectsWrongKey: unauth.status === 401,
        status: res.status,
        ...summary,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error("ERROR:", String(e.message).split("\n")[0]);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
