import prisma from "../../src/lib/prisma";
import { DEFAULT_CASE_AREAS } from "../../src/constants/case-area.constants";

// The kinds of problem a UK client case can be about. The case_areas migration already inserted
// them; this puts back any default that's missing (deleted from a dev database, say). Create-only
// and matched by code, so an area an admin renamed, redescribed, reordered or switched off is left
// as it is. A re-added default goes to the end of the list.
export async function seedCaseAreas() {
  for (const area of DEFAULT_CASE_AREAS) {
    if (await prisma.caseArea.findUnique({ where: { country_code: { country: "UK", code: area.code } } })) continue;
    const { _max } = await prisma.caseArea.aggregate({ where: { country: "UK" }, _max: { sortOrder: true } });
    await prisma.caseArea.create({ data: { country: "UK", ...area, sortOrder: (_max.sortOrder ?? -1) + 1 } });
  }
}
