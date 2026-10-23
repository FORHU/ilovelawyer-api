/**
 * Local-demo only, not for commit: seeds a LAWYER account that already owns a case over its $20 AI
 * allowance, so the Case Workspace's locked banner / top-up flow can be demoed immediately instead
 * of burning through real chat messages first.
 *
 *   npx ts-node --files scripts/seed-locked-demo-lawyer.ts
 */
import bcrypt from "bcrypt";
import prisma from "../src/lib/prisma";
import { BCRYPT_SALT_ROUNDS } from "../src/constants/auth.constants";

const UK_TENANT_ID = "00000000-0000-0000-0000-000000000002";
const EMAIL = "demo.topup.lawyer@example.com";
const PASSWORD = "Demo-Password-123!";

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_SALT_ROUNDS);

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: {
      email: EMAIL,
      password: passwordHash,
      name: "Demo Topup Lawyer",
      username: "demo-topup-lawyer",
      role: "LAWYER",
      tenantId: UK_TENANT_ID,
      isEmailVerified: true,
      approvalStatus: "ACTIVE",
      onboardingCompleted: true,
      termsAcceptedAt: new Date(),
      termsVersion: "seed",
      freeCreditUsd: null,
    },
  });

  let org = await prisma.organization.findFirst({ where: { createdById: user.id, isPersonal: true } });
  if (!org) {
    org = await prisma.organization.create({
      data: { name: "Demo Topup Lawyer's Workspace", slug: `demo-topup-lawyer-${user.id.slice(0, 8)}`, isPersonal: true, createdById: user.id, tenantId: UK_TENANT_ID },
    });
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: "OWNER", status: "ACCEPTED" } });
  }

  let caseRecord = await prisma.case.findFirst({ where: { userId: user.id, caseName: "Demo: AI allowance exhausted" } });
  if (!caseRecord) {
    caseRecord = await prisma.case.create({
      data: { userId: user.id, organizationId: org.id, caseName: "Demo: AI allowance exhausted", status: "ACTIVE" },
    });
  }

  const existingUsage = await prisma.llmUsage.aggregate({ where: { caseId: caseRecord.id }, _sum: { estimatedCostUsd: true } });
  const spent = existingUsage._sum.estimatedCostUsd ?? 0;
  if (spent < 20) {
    await prisma.llmUsage.create({
      data: {
        provider: "OPENAI",
        feature: "chat",
        source: "ESTIMATED",
        inputTokens: 1000,
        outputTokens: 1000,
        totalTokens: 2000,
        estimatedCostUsd: 25 - spent,
        userId: user.id,
        caseId: caseRecord.id,
      },
    });
  }

  console.log(`Lawyer: ${EMAIL} / ${PASSWORD}`);
  console.log(`Organization: ${org.id}`);
  console.log(`Case: ${caseRecord.id} ("${caseRecord.caseName}")`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
