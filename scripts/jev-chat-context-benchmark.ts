/**
 * Tests whether the urgency note flagMessageUrgency injects into resolvedContext (see
 * processChatGenerationJob in chat.service.ts) actually changes chat-wonder's real response —
 * not just whether Jev classifies correctly (that's covered by jev-message-triage-benchmark.ts).
 * For each case, runs the SAME userInput through streamChatWonderMessage twice: once with no
 * document_context, once with the urgency note chat.service.ts would actually inject, and prints
 * both full responses side by side plus a crude urgency-language word count.
 *
 *   npx ts-node scripts/jev-chat-context-benchmark.ts
 *
 * Slow — each case is 2 full chat-wonder generations, sequential (fresh session per call).
 * Requires TYPESAFE_API_KEY (for the Jev triage call) and a reachable CHAT_WONDER_WS_URL.
 * Writes results to benchmarks/jev-chat-context/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import { getChatWonderSessionId, streamChatWonderMessage } from "../src/utils/chatWonder";
import { flagMessageUrgency } from "../src/utils/message-triage";

interface Case {
  label: string;
  userInput: string;
}

const CASES: Case[] = [
  {
    label: "eviction, 48hr deadline",
    userInput:
      "Our client just received a Notice to Vacate with a 48-hour compliance deadline — the sheriff is scheduled to execute tomorrow morning. What can we file right now to stop this?",
  },
  {
    label: "statute of limitations expires tonight",
    userInput: "Statute of limitations on this claim expires at midnight tonight — what are our options?",
  },
];

const URGENCY_WORDS = ["urgent", "immediately", "right away", "as soon as possible", "asap", "priority", "prioritize", "emergency", "time-sensitive", "without delay"];

function countUrgencyLanguage(text: string): number {
  const lower = text.toLowerCase();
  return URGENCY_WORDS.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
}

async function runChat(userInput: string, documentContext: string): Promise<{ content: string; ms: number }> {
  const sessionId = await getChatWonderSessionId();
  const start = Date.now();
  const result = await streamChatWonderMessage(sessionId, userInput, () => {}, documentContext, undefined, undefined, "PH");
  return { content: result.content ?? "", ms: Date.now() - start };
}

async function main() {
  const sections: string[] = [];

  for (const c of CASES) {
    console.log(`\n=== ${c.label} ===`);
    const urgency = await flagMessageUrgency(c.userInput);
    const urgencyContext = urgency?.urgent
      ? `[Jev triage] This message was flagged as urgent (${Math.round(urgency.probability * 100)}% confidence) — it may involve a time-sensitive deadline, an imminent hearing, or an emergency. Prioritize directness and actionable next steps in your response.`
      : "";
    console.log(`Jev urgency: ${urgency?.urgent} (${Math.round((urgency?.probability ?? 0) * 100)}%)`);

    console.log("Running WITHOUT urgency note...");
    const without = await runChat(c.userInput, "");
    console.log(`  ${without.ms}ms, ${without.content.length} chars, urgency-language hits: ${countUrgencyLanguage(without.content)}`);

    console.log("Running WITH urgency note...");
    const withNote = await runChat(c.userInput, urgencyContext);
    console.log(`  ${withNote.ms}ms, ${withNote.content.length} chars, urgency-language hits: ${countUrgencyLanguage(withNote.content)}`);

    sections.push(
      [
        `## ${c.label}`,
        ``,
        `**Message:** ${c.userInput}`,
        ``,
        `**Jev urgency:** ${urgency?.urgent} (${Math.round((urgency?.probability ?? 0) * 100)}%)`,
        ``,
        `| | Without note | With note |`,
        `| --- | --- | --- |`,
        `| Length | ${without.content.length} chars | ${withNote.content.length} chars |`,
        `| Latency | ${without.ms}ms | ${withNote.ms}ms |`,
        `| Urgency-language hits | ${countUrgencyLanguage(without.content)} | ${countUrgencyLanguage(withNote.content)} |`,
        ``,
        `### Response WITHOUT urgency note`,
        ``,
        without.content,
        ``,
        `### Response WITH urgency note`,
        ``,
        withNote.content,
      ].join("\n"),
    );
  }

  const summary = [`# Jev chat context injection benchmark`, ``, `Run: ${new Date().toISOString()}`, ``, ...sections].join("\n\n");

  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-chat-context");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, summary);
  console.log(`\nWritten to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
