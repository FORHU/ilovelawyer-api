import { sendMessage, receiveMessages, deleteMessage } from "../src/lib/sqs";
import { AI_GENERATION_QUEUE_URL } from "../src/config";

async function main() {
  const probe = JSON.stringify({ kind: "connectivity-probe", ts: Date.now() });
  console.log("Sending:", probe);
  await sendMessage(AI_GENERATION_QUEUE_URL, probe);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const messages = await receiveMessages(AI_GENERATION_QUEUE_URL, 10, 30);
    console.log(`Poll returned ${messages.length} message(s)`);
    const found = messages.find((m) => m.body === probe);
    if (found) {
      console.log("Found our probe. Deleting...");
      await deleteMessage(AI_GENERATION_QUEUE_URL, found.receiptHandle);
      console.log("SUCCESS: send -> receive -> delete round trip works end to end.");
      return;
    }
    for (const m of messages) {
      // Drain any leftover probes from earlier failed runs so they stop cluttering the queue.
      console.log("Draining stale message:", m.body.slice(0, 60));
      await deleteMessage(AI_GENERATION_QUEUE_URL, m.receiptHandle).catch(() => {});
    }
  }
  console.error("Still didn't see it within 60s.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
