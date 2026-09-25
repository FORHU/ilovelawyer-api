import prisma from "../lib/prisma";

/** Reads for the grounding verification rows written by GroundingVerifierSvc. Writes happen in the
 * service itself (one createMany per answer), so this is read-only by design. */
export default class AnswerGroundingRepo {
  /** Case-wide rows for the Verification panel, worst first: a contradicted assertion or a
   * document the answer wrongly said was missing is what a lawyer needs to see, not the hundreds
   * of assertions that checked out. */
  static async listForCase(caseId: string, limit = 200) {
    const rows = await prisma.answerGroundingCheck.findMany({
      where: { caseId },
      select: {
        id: true,
        messageId: true,
        kind: true,
        assertion: true,
        citation: true,
        documentId: true,
        verdict: true,
        confidence: true,
        evidenceKind: true,
        createdAt: true,
        message: { select: { consultationId: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const severity: Record<string, number> = { CONTRADICTED: 0, FALSE_ABSENCE: 1, UNSUPPORTED: 2, NOT_SUPPLIED: 3, UNRESOLVED: 4, CORRECT_ABSENCE: 5, SUPPORTED: 6 };
    return rows.sort((a, b) => (severity[a.verdict] ?? 9) - (severity[b.verdict] ?? 9) || b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Counts per verdict for the panel header and the case dashboard. */
  static async countsForCase(caseId: string): Promise<Record<string, number>> {
    const grouped = await prisma.answerGroundingCheck.groupBy({ by: ["verdict"], where: { caseId }, _count: { _all: true } });
    return Object.fromEntries(grouped.map((g) => [g.verdict, g._count._all]));
  }

  /** The full stored row including the passage the verdict was reached against — the audit view
   * for one disputed verdict, deliberately not part of any list response. */
  static async findById(id: string, caseId: string) {
    return prisma.answerGroundingCheck.findFirst({ where: { id, caseId } });
  }
}
