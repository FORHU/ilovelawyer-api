import prisma from "../../src/lib/prisma";

/** Gives these lawyers' profiles one of the seeded practice areas (the practice_areas migration).
 * UK "Employment Law" maps to the EMPLOYMENT case area, so they match employment cases. The rows go
 * when the profile does (onDelete: Cascade). */
export async function givePracticeArea(userIds: string[], name = "Employment Law", country = "UK") {
  const area = await prisma.practiceArea.findFirstOrThrow({ where: { country, name } });
  await prisma.lawyerPracticeArea.createMany({ data: userIds.map((userId) => ({ userId, practiceAreaId: area.id })) });
}
