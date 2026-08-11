/**
 * One-time script: generate titles for all consultations where title IS NULL.
 * Run: npx ts-node scripts/backfill-titles.ts
 */
import * as dotenv from "dotenv";
dotenv.config();

import prisma from "../src/lib/prisma";
import { generateTitleViaWs } from "../src/utils/chatWonder";
import ChatSvc from "../src/services/chat.service";

const DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const consultations = await prisma.consultation.findMany({
    select: { id: true, title: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${consultations.length} untitled consultations.`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const { id, title } of consultations) {
    const messages = await prisma.message.findMany({
      where: { consultationId: id },
      orderBy: { createdAt: "asc" },
      take: 4,
    });

    const userMsg = messages.find((m) => m.role === "user");
    const assistantMsg = messages.find((m) => m.role === "assistant");

    if (!userMsg || !assistantMsg) {
      console.log(`  [skip] ${id} — not enough messages`);
      skipped++;
      continue;
    }

    // Skip if title already looks AI-generated (contains ":" or "—" separator)
    if (title && (title.includes(":") || title.includes("—"))) {
      console.log(`  [skip] ${id} — already has generated title: "${title}"`);
      skipped++;
      continue;
    }

    try {
      const raw = await generateTitleViaWs(
        ChatSvc.buildTitlePrompt(userMsg.content),
      );
      if (!raw) {
        console.log(`  [skip] ${id} — empty response`);
        skipped++;
        continue;
      }

      const title = ChatSvc.parseTitle(raw);
      if (!title) {
        console.log(`  [skip] ${id} — could not parse title from: ${raw.slice(0, 80)}`);
        skipped++;
        continue;
      }

      await prisma.consultation.update({ where: { id }, data: { title } });
      console.log(`  [ok]   ${id} — "${title}"`);
      success++;
    } catch (err) {
      console.error(`  [fail] ${id} —`, (err as Error).message);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nDone. success=${success} skipped=${skipped} failed=${failed}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
