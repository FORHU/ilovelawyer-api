/**
 * One-time backfill: copies each client-workspace case's existing chat history (old shared
 * Message/Consultation tables) into its own IntakeMessage rows, so a case chatted in before the
 * intake-pipeline split (feat/intake-pipeline) doesn't show an empty Interview tab, an empty
 * lawyer brief ("(no conversation yet)"), or a reset intake overview once this ships.
 *
 * Idempotent and safe to re-run: a case already holding any IntakeMessage rows is skipped
 * entirely, never duplicated or merged. Run once, after this branch's migrations are applied and
 * before (or immediately after) the deploy that starts reading IntakeMessage instead of Message
 * for client cases.
 *
 * NOT run automatically as part of any migration or deploy step — this only ever touches
 * encrypted free-text message content, so it is run by a person, by hand, against one
 * environment at a time:
 *
 *   npx ts-node --files scripts/backfill-intake-messages.ts            # dry run, no writes
 *   npx ts-node --files scripts/backfill-intake-messages.ts --write    # actually writes
 *
 * Dry run prints exactly what it would do (case count, message count, any case it would skip and
 * why) without touching the database. Review that output before passing --write.
 */
import prisma from "../src/lib/prisma";
import { openMessage } from "../src/utils/message-content";
import { sealIntakeMessageContent } from "../src/utils/intake-message-content";
import type { IntakeMessageReplyStatus, IntakeMessageRole, MessageReplyStatus, MessageRole } from "@prisma/client";

const WRITE = process.argv.includes("--write");

async function main() {
  const candidates = await prisma.case.findMany({
    where: {
      organization: { isPersonal: true, createdBy: { role: "USER" } },
      intakeMessages: { none: {} },
      consultations: { some: { status: "ACTIVE" } },
    },
    select: {
      id: true,
      caseName: true,
      consultations: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 1, select: { id: true } },
    },
  });

  console.log(`Found ${candidates.length} client case(s) with no IntakeMessage rows yet.`);

  let casesTouched = 0;
  let messagesCopied = 0;
  let casesSkippedEmpty = 0;

  for (const c of candidates) {
    const consultationId = c.consultations[0]?.id;
    if (!consultationId) continue; // can't happen given the where-clause, but keep TS honest

    const rows = await prisma.message.findMany({
      where: { consultationId, role: { in: ["user", "assistant"] } },
      orderBy: { createdAt: "asc" },
      include: { documents: { select: { id: true } } },
    });
    if (!rows.length) {
      casesSkippedEmpty++;
      continue;
    }

    const toInsert = rows
      .map((row) => openMessage(row))
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map((row) => ({
        caseId: c.id,
        role: row.role as unknown as IntakeMessageRole,
        content: sealIntakeMessageContent(row.content),
        userId: row.role === "user" ? row.userId : null,
        documentIds: row.role === "user" ? row.documents.map((d) => d.id) : [],
        // A user turn still PENDING here never got its reply before this history stopped being
        // live (the old pipeline is retired) — carried over as FAILED rather than an eternal
        // "thinking" spinner with no worker left that will ever finish it.
        replyStatus:
          row.role === "user"
            ? (((row.replyStatus as MessageReplyStatus | null) === "PENDING" ? "FAILED" : row.replyStatus) as IntakeMessageReplyStatus | null)
            : null,
        createdAt: row.createdAt,
      }));

    console.log(`${WRITE ? "Writing" : "Would write"} ${toInsert.length} message(s) for case ${c.id} ("${c.caseName}")`);
    if (WRITE) {
      await prisma.$transaction(toInsert.map((data) => prisma.intakeMessage.create({ data })));
    }
    casesTouched++;
    messagesCopied += toInsert.length;
  }

  console.log("");
  console.log(`${WRITE ? "Wrote" : "Would write"} ${messagesCopied} message(s) across ${casesTouched} case(s).`);
  if (casesSkippedEmpty) console.log(`${casesSkippedEmpty} case(s) had a consultation but no user/assistant messages — nothing to copy.`);
  if (!WRITE) console.log("Dry run only — re-run with --write to actually copy.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
