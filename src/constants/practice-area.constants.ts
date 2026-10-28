import type { LawyerCountry } from "./lawyer-application.constants";

export interface DefaultPracticeArea {
  name: string;
  /** The CaseArea code (DEFAULT_CASE_AREAS) a lawyer holding this area is matched to (UK only). */
  caseArea?: string;
}

/**
 * The practice areas every site starts with, in picker order. The practice_areas migration inserted
 * them, and prisma/seeders/practice-area.seeder.ts adds back any that are missing; neither touches a
 * row an admin has since edited. UK leaves out personal injury and medical negligence: referral
 * fees are banned there. Matching is UK only, so only UK areas carry a caseArea, and an area
 * without one is listed on the profile but never routes.
 */
export const DEFAULT_PRACTICE_AREAS: Record<LawyerCountry, readonly DefaultPracticeArea[]> = {
  UK: [
    { name: "Family Law", caseArea: "FAMILY" },
    { name: "Employment Law", caseArea: "EMPLOYMENT" },
    { name: "Immigration Law" },
    { name: "Criminal Law" },
    { name: "Civil Litigation", caseArea: "OTHER" },
    { name: "Commercial Litigation" },
    { name: "Corporate Law" },
    { name: "Commercial Law" },
    { name: "Property Law", caseArea: "PROPERTY" },
    { name: "Real Estate Law", caseArea: "PROPERTY" },
    { name: "Construction Law" },
    { name: "Contract Law" },
    { name: "Intellectual Property Law" },
    { name: "Data Protection and Privacy Law" },
    { name: "Tax Law" },
    { name: "Banking and Finance Law" },
    { name: "Insolvency and Restructuring" },
    { name: "Wills and Probate" },
    { name: "Human Rights Law" },
    { name: "Public and Administrative Law" },
    { name: "Environmental Law" },
    { name: "Competition Law" },
    { name: "Arbitration and Mediation" },
    { name: "Consumer Law", caseArea: "CONSUMER" },
    { name: "Insurance Law" },
    { name: "Defamation Law" },
    { name: "Professional Negligence" },
    { name: "International Law" },
  ],
  PH: [
    { name: "Family Law" },
    { name: "Labor and Employment Law" },
    { name: "Criminal Law" },
    { name: "Civil Law" },
    { name: "Corporate Law" },
    { name: "Commercial Law" },
    { name: "Property and Real Estate Law" },
    { name: "Immigration Law" },
    { name: "Tax Law" },
    { name: "Intellectual Property Law" },
    { name: "Data Privacy Law" },
    { name: "Cybercrime Law" },
    { name: "Commercial Litigation" },
    { name: "Civil Litigation" },
    { name: "Administrative Law" },
    { name: "Constitutional Law" },
    { name: "Election Law" },
    { name: "Environmental Law" },
    { name: "Banking and Finance Law" },
    { name: "Insurance Law" },
    { name: "Construction Law" },
    { name: "Energy Law" },
    { name: "Maritime and Admiralty Law" },
    { name: "Wills and Estate Settlement" },
    { name: "Arbitration and Mediation" },
    { name: "Consumer Protection Law" },
    { name: "Human Rights Law" },
    { name: "Land Registration and Titling" },
    { name: "Agrarian Reform Law" },
    { name: "Anti-Graft and Corruption Law" },
  ],
};

export const PRACTICE_AREA_NAME_MAX_LENGTH = 100;
