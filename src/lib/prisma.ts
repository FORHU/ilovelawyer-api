import * as dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

// Load .env here rather than relying on some other module in the import graph doing it first
// (e.g. config.ts) — DATABASE_URL must be set before `new PrismaClient()` reads it below, and
// that shouldn't depend on import order elsewhere. dotenv.config() is idempotent, so this is
// safe to call again if config.ts (or anything else) also calls it.
dotenv.config();

const prisma = new PrismaClient();

export default prisma;
