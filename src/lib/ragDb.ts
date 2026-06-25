import { Pool } from "pg";
import { RAG_DATABASE_URL } from "../config";

const isLocal = RAG_DATABASE_URL.includes("localhost") || RAG_DATABASE_URL.includes("127.0.0.1");

const ragPool = new Pool({
  connectionString: RAG_DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

export default ragPool;
