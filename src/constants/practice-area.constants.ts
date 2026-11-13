import type { LawyerCountry } from "./lawyer-application.constants";

export interface DefaultPracticeArea {
  name: string;
  /** The code of the site's CaseArea (DEFAULT_CASE_AREAS) a lawyer holding this area is matched to. */
  caseArea?: string;
}

/**
 * The practice areas every site starts with, in picker order. The practice_areas migration inserted
 * them, the map_practice_areas migration gave each one a caseArea, and
 * prisma/seeders/practice-area.seeder.ts adds back any that are missing; none of them touches a row
 * an admin has since edited. UK leaves out personal injury and medical negligence: referral fees
 * are banned there. Every area maps to one of its site's case areas; matching is UK only for now,
 * so PH's mappings wait for PH client cases. Only the generalist areas route OTHER: it takes the
 * cases nothing else fits, so they must reach somebody.
 */
export const DEFAULT_PRACTICE_AREAS: Record<LawyerCountry, readonly DefaultPracticeArea[]> = {
  UK: [
    { name: "Family Law", caseArea: "FAMILY" },
    { name: "Employment Law", caseArea: "EMPLOYMENT" },
    { name: "Immigration Law", caseArea: "IMMIGRATION" },
    { name: "Criminal Law", caseArea: "CRIMINAL" },
    { name: "Civil Litigation", caseArea: "OTHER" },
    { name: "Commercial Litigation", caseArea: "BUSINESS" },
    { name: "Corporate Law", caseArea: "BUSINESS" },
    { name: "Commercial Law", caseArea: "BUSINESS" },
    { name: "Property Law", caseArea: "PROPERTY" },
    { name: "Real Estate Law", caseArea: "PROPERTY" },
    { name: "Construction Law", caseArea: "PROPERTY" },
    { name: "Contract Law", caseArea: "CONSUMER" },
    { name: "Intellectual Property Law", caseArea: "INTELLECTUAL_PROPERTY" },
    { name: "Data Protection and Privacy Law", caseArea: "REPUTATION_PRIVACY" },
    { name: "Tax Law", caseArea: "TAX" },
    { name: "Banking and Finance Law", caseArea: "CONSUMER" },
    { name: "Insolvency and Restructuring", caseArea: "DEBT_INSOLVENCY" },
    { name: "Wills and Probate", caseArea: "WILLS_PROBATE" },
    { name: "Human Rights Law", caseArea: "PUBLIC_BODIES" },
    { name: "Public and Administrative Law", caseArea: "PUBLIC_BODIES" },
    { name: "Environmental Law", caseArea: "PUBLIC_BODIES" },
    { name: "Competition Law", caseArea: "BUSINESS" },
    { name: "Arbitration and Mediation", caseArea: "OTHER" },
    { name: "Consumer Law", caseArea: "CONSUMER" },
    { name: "Insurance Law", caseArea: "CONSUMER" },
    { name: "Defamation Law", caseArea: "REPUTATION_PRIVACY" },
    { name: "Professional Negligence", caseArea: "CONSUMER" },
    { name: "International Law", caseArea: "OTHER" },
  ],
  PH: [
    { name: "Family Law", caseArea: "FAMILY" },
    { name: "Labor and Employment Law", caseArea: "EMPLOYMENT" },
    { name: "Criminal Law", caseArea: "CRIMINAL" },
    { name: "Civil Law", caseArea: "OTHER" },
    { name: "Corporate Law", caseArea: "BUSINESS" },
    { name: "Commercial Law", caseArea: "BUSINESS" },
    { name: "Property and Real Estate Law", caseArea: "PROPERTY" },
    { name: "Immigration Law", caseArea: "IMMIGRATION" },
    { name: "Tax Law", caseArea: "TAX" },
    { name: "Intellectual Property Law", caseArea: "INTELLECTUAL_PROPERTY" },
    { name: "Data Privacy Law", caseArea: "REPUTATION_PRIVACY" },
    { name: "Cybercrime Law", caseArea: "REPUTATION_PRIVACY" },
    { name: "Commercial Litigation", caseArea: "BUSINESS" },
    { name: "Civil Litigation", caseArea: "OTHER" },
    { name: "Administrative Law", caseArea: "PUBLIC_BODIES" },
    { name: "Constitutional Law", caseArea: "PUBLIC_BODIES" },
    { name: "Election Law", caseArea: "PUBLIC_BODIES" },
    { name: "Environmental Law", caseArea: "PUBLIC_BODIES" },
    { name: "Banking and Finance Law", caseArea: "CONSUMER" },
    { name: "Insurance Law", caseArea: "CONSUMER" },
    { name: "Construction Law", caseArea: "PROPERTY" },
    { name: "Energy Law", caseArea: "BUSINESS" },
    { name: "Maritime and Admiralty Law", caseArea: "BUSINESS" },
    { name: "Wills and Estate Settlement", caseArea: "WILLS_PROBATE" },
    { name: "Arbitration and Mediation", caseArea: "OTHER" },
    { name: "Consumer Protection Law", caseArea: "CONSUMER" },
    { name: "Human Rights Law", caseArea: "PUBLIC_BODIES" },
    { name: "Land Registration and Titling", caseArea: "PROPERTY" },
    { name: "Agrarian Reform Law", caseArea: "PROPERTY" },
    { name: "Anti-Graft and Corruption Law", caseArea: "PUBLIC_BODIES" },
  ],
  // Korean first, English in brackets: the KR site opens in Korean. 민사 is the generalist area, so
  // it takes OTHER. Matching is UK only for now, so these mappings wait for KR client cases.
  KR: [
    { name: "민사 (Civil Law)", caseArea: "OTHER" },
    { name: "형사 (Criminal Law)", caseArea: "CRIMINAL" },
    { name: "가사·이혼 (Family and Divorce)", caseArea: "FAMILY" },
    { name: "노동 (Labour and Employment)", caseArea: "EMPLOYMENT" },
    { name: "부동산·임대차 (Real Estate and Leases)", caseArea: "PROPERTY" },
    { name: "기업법무 (Corporate Law)", caseArea: "BUSINESS" },
    { name: "행정 (Administrative Law)", caseArea: "PUBLIC_BODIES" },
    { name: "지식재산 (Intellectual Property)", caseArea: "INTELLECTUAL_PROPERTY" },
    { name: "조세 (Tax)", caseArea: "TAX" },
    { name: "의료 (Medical Law)", caseArea: "MEDICAL" },
  ],
};

export const PRACTICE_AREA_NAME_MAX_LENGTH = 100;
