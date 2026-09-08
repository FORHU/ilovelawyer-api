/** Real end-to-end test of the local heuristic topic split — calls ChatSvc.sendMessage
 * directly (same code path the HTTP controller uses), for real, against chat-dev.forhu.ai,
 * no seeding. Run: npx ts-node scripts/_tmp-e2e-test.ts */
import * as dotenv from "dotenv";
dotenv.config();
import prisma from "../src/lib/prisma";
import ChatSvc from "../src/services/chat.service";

async function main() {
  const consultation = await prisma.consultation.findUnique({
    where: { id: "94bbd650-6f04-42e4-a8c8-ba4338bfe863" },
  });
  if (!consultation) throw new Error("consultation not found");

  console.log("Sending a fresh message...");
  let chunks = 0;
  await ChatSvc.sendMessage(
    consultation.organizationId,
    "UK",
    consultation.userId,
    consultation.id,
    "",
    "Explain the difference between criminal law and civil law in the UK, and how courts and tribunals are organized.",
    () => {
      chunks++;
    },
  );
  console.log(`Done streaming (${chunks} chunks). Checking persisted result...`);

  const groups = await prisma.messageGroup.findMany({
    where: { consultationId: consultation.id },
    orderBy: { createdAt: "desc" },
    take: 1,
    include: { messages: { orderBy: { groupOrder: "asc" }, select: { groupTitle: true, groupOrder: true } } },
  });

  if (groups.length === 0) {
    console.log("No MessageGroup found — reply did not split (check heading structure).");
  } else {
    console.log(`New MessageGroup ${groups[0].id} with ${groups[0].messages.length} topics:`);
    groups[0].messages.forEach((m) => console.log(`  ${m.groupOrder}: ${m.groupTitle}`));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
