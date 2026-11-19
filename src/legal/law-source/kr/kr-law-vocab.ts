import { LawCategory } from "@prisma/client";

/**
 * KR Library wire vocab. `kr-case-law` -> `JURISPRUDENCE` (판례), `kr-legislation` -> `REPUBLIC_ACT`
 * (법령) — the `LawCategory` enum is reused, as UK does (docs/adr/0005-uk-library-source.md).
 */
export const KR_CATEGORY_WIRE_VALUES = ["kr-case-law", "kr-legislation"] as const;
export type KrCategoryWire = (typeof KR_CATEGORY_WIRE_VALUES)[number];

export const KR_CATEGORY_BY_WIRE: Record<KrCategoryWire, LawCategory> = {
  "kr-case-law": "JURISPRUDENCE",
  "kr-legislation": "REPUBLIC_ACT",
};

export const KR_WIRE_BY_CATEGORY: Record<LawCategory, KrCategoryWire> = {
  JURISPRUDENCE: "kr-case-law",
  REPUBLIC_ACT: "kr-legislation",
};

/**
 * Courts accepted on `?court=` for KR case law: the court's own name, which is what law.go.kr's
 * precedent search filters on (an exact name — "고등법원" alone matches nothing). Each was checked
 * live to return decisions. The Constitutional Court isn't here: its decisions are a separate
 * law.go.kr dataset, not precedents.
 */
export const KR_COURTS = [
  "대법원",
  "서울고등법원",
  "부산고등법원",
  "대구고등법원",
  "광주고등법원",
  "대전고등법원",
  "수원고등법원",
  "특허법원",
  "서울행정법원",
  "서울가정법원",
  "서울중앙지방법원",
  "서울동부지방법원",
  "수원지방법원",
  "인천지방법원",
  "부산지방법원",
] as const;
export type KrCourt = (typeof KR_COURTS)[number];

/** `Law.jurisSourceId` prefixes: a statute by its MST (법령일련번호, one version of a law), a
 * decision by its law.go.kr precedent serial number. */
export const KR_LAW_ID_PREFIX = "kr:law:";
export const KR_PRECEDENT_ID_PREFIX = "kr:prec:";

/** law.go.kr's own pages, the "View source" link. */
export const krLawUrl = (mst: string) => `https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=${encodeURIComponent(mst)}`;
export const krPrecedentUrl = (id: string) => `https://www.law.go.kr/LSW/precInfoP.do?precSeq=${encodeURIComponent(id)}`;
