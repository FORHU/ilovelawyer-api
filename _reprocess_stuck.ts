import prisma from "./src/lib/prisma";
import DocumentExtractionSvc from "./src/services/document-extraction.service";

(async () => {
  const docs = await prisma.document.findMany({
    where: { ragStatus: { in: ["PENDING", "FAILED"] } },
    select: { id: true, name: true },
  });

  console.log(`Reprocessing ${docs.length} documents...`);
  const results: { id: string; name: string; ragStatus: string }[] = [];

  for (const doc of docs) {
    await DocumentExtractionSvc.process(doc.id);
    const updated = await prisma.document.findUnique({ where: { id: doc.id }, select: { ragStatus: true } });
    results.push({ id: doc.id, name: doc.name, ragStatus: updated?.ragStatus ?? "UNKNOWN" });
    console.log(`${updated?.ragStatus?.padEnd(7)} ${doc.name} (${doc.id})`);
  }

  const summary = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.ragStatus] = (acc[r.ragStatus] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\nSummary:", summary);

  await prisma.$disconnect();
})();
