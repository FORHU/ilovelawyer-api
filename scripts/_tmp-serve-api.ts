/**
 * Benchmark-only HTTP server: serves the same Express app as src/server.ts but does NOT start
 * any SQS queue worker. src/server.ts starts seven of them against the shared dev queues, and
 * DocumentExtractionQueue additionally sweeps PENDING rows out of the database — running that
 * locally would consume dev jobs and re-extract other people's documents.
 *
 * Exists only so chat-wonder's get_case_document callback has an ILOVELAWYER_API_BASE that
 * serves the staging database. Delete when the BM25 A/B is done.
 */
import * as dotenv from "dotenv";
dotenv.config();
import server from "../src/app";

const PORT = Number(process.env.BENCH_API_PORT || 3999);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bench-api] listening on http://127.0.0.1:${PORT} (no queue workers started)`);
});
