import { Pool } from "pg";

const globalForRag = globalThis as unknown as { ragPool: Pool | undefined };

function createRagPool(): Pool {
  const url = process.env.DATABASE_URL;
  const connectionString = url ?? "postgresql://placeholder@localhost/placeholder";
  const isLocal = !url || connectionString.includes("localhost") || connectionString.includes("127.0.0.1");
  return new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
}

export const ragPool = globalForRag.ragPool ?? createRagPool();

if (process.env.NODE_ENV !== "production") globalForRag.ragPool = ragPool;

export default ragPool;
