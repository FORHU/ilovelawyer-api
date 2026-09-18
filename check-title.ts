import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.consultation.findMany({
    where: { id: "446e0de6-7d49-4cc2-ad46-3f817adcfcb0" },
    select: { id: true, title: true, createdAt: true },
  });
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
})();
