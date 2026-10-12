import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { usesTenantKeys } from "./field-crypto";

type Db = Prisma.TransactionClient | typeof prisma;

/** The tenant code ("PH", "UK") of the organization that owns a document, so its text is sealed with
 * that tenant's key. Returns undefined, without touching the database, on every server that uses a
 * single key. */
export async function tenantOfDocument(documentId: string, client: Db = prisma): Promise<string | undefined> {
  if (!usesTenantKeys()) return undefined;
  const document = await client.document.findUnique({ where: { id: documentId }, select: { organization: { select: { tenant: { select: { code: true } } } } } });
  return document?.organization.tenant.code;
}

/** The same for a case, for the notes on its evidence. A case with no organization (a personal case)
 * has no tenant of its own and uses the default key. */
export async function tenantOfCase(caseId: string, client: Db = prisma): Promise<string | undefined> {
  if (!usesTenantKeys()) return undefined;
  const found = await client.case.findUnique({ where: { id: caseId }, select: { organization: { select: { tenant: { select: { code: true } } } } } });
  return found?.organization?.tenant.code;
}
