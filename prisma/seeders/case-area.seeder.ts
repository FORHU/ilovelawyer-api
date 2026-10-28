import prisma from "../../src/lib/prisma";
import { LAWYER_COUNTRIES } from "../../src/constants/lawyer-application.constants";
import { DEFAULT_CASE_AREAS } from "../../src/constants/case-area.constants";

// The kinds of problem a client case can be about, one list per site. The case_areas and
// map_practice_areas migrations already inserted them; this puts back any default that's missing
// (deleted from a dev database, say). Create-only and matched by code, so an area an admin renamed,
// redescribed, reordered or switched off is left as it is. A re-added default goes to the end of
// the list.
export async function seedCaseAreas() {
  for (const country of LAWYER_COUNTRIES) {
    for (const area of DEFAULT_CASE_AREAS[country]) {
      if (await prisma.caseArea.findUnique({ where: { country_code: { country, code: area.code } } })) continue;
      const { _max } = await prisma.caseArea.aggregate({ where: { country }, _max: { sortOrder: true } });
      await prisma.caseArea.create({ data: { country, ...area, sortOrder: (_max.sortOrder ?? -1) + 1 } });
    }
  }
}
