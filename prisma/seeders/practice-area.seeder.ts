import prisma from "../../src/lib/prisma";
import { LAWYER_COUNTRIES } from "../../src/constants/lawyer-application.constants";
import { DEFAULT_PRACTICE_AREAS } from "../../src/constants/practice-area.constants";

// The practice areas each site starts with. The practice_areas migration already inserted them;
// this puts back any default that's missing (deleted from a dev database, say). Create-only and
// matched by name whatever its case, so an area an admin renamed, remapped, reordered or switched
// off is left as it is. A re-added default goes to the end of the list.
export async function seedPracticeAreas() {
  for (const country of LAWYER_COUNTRIES) {
    for (const area of DEFAULT_PRACTICE_AREAS[country]) {
      const existing = await prisma.practiceArea.findFirst({ where: { country, name: { equals: area.name, mode: "insensitive" } } });
      if (existing) continue;
      const { _max } = await prisma.practiceArea.aggregate({ where: { country }, _max: { sortOrder: true } });
      await prisma.practiceArea.create({ data: { country, name: area.name, caseArea: area.caseArea ?? null, sortOrder: (_max.sortOrder ?? -1) + 1 } });
    }
  }
}
