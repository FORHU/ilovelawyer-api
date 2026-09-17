require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const prefix = process.argv[2] || "D20";
prisma.document
  .findFirst({
    where: { caseId: "8aedbceb-aa41-467f-88f1-9b4601db644b", name: { startsWith: prefix } },
    select: { id: true },
  })
  .then((d) => console.log(d ? d.id : "NOT_FOUND"))
  .finally(() => prisma.$disconnect());
