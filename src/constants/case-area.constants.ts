import type { LawyerCountry } from "./lawyer-application.constants";

export interface DefaultCaseArea {
  code: string;
  name: string;
  description: string;
}

/** Client cases are UK only for now, so every case's areas are the UK list's. PH has its own list,
 * and its practice areas map to it, ready for when PH has client cases. */
export const CLIENT_CASE_COUNTRY: LawyerCountry = "UK";

/** Where a case nothing else fits goes. Always there and always on: it can be renamed, but not
 * switched off or deleted. */
export const OTHER_CASE_AREA = "OTHER";

/** Never a case area: referral fees are banned in personal injury, so Jev recognises it on its own
 * and such cases are refused a lawyer (PERSONAL_INJURY_EXCLUDED). */
export const PERSONAL_INJURY = "PERSONAL_INJURY";

/**
 * The kinds of problem a client's case can be about that each site starts with, in picker order.
 * The case_areas and map_practice_areas migrations inserted them, and
 * prisma/seeders/case-area.seeder.ts adds back any that are missing; none of them touches a row an
 * admin has since edited. The first five UK descriptions are what Jev was told before admins could
 * edit them. PH has no client cases yet, so its list is only ready for when it does.
 */
export const DEFAULT_CASE_AREAS: Record<LawyerCountry, readonly DefaultCaseArea[]> = {
  UK: [
    { code: "EMPLOYMENT", name: "Employment", description: "Work, dismissal, pay, discrimination at work." },
    { code: "PROPERTY", name: "Property", description: "Renting, landlords, deposits, buying or owning a home, neighbours." },
    { code: "FAMILY", name: "Family", description: "Divorce, separation, children." },
    { code: "CONSUMER", name: "Consumer", description: "Goods, services, refunds, problems with a business." },
    { code: "IMMIGRATION", name: "Immigration", description: "Visas, asylum, the right to live or work in the UK, deportation." },
    { code: "CRIMINAL", name: "Criminal", description: "Being questioned, arrested, charged or prosecuted for a crime, or a criminal record." },
    { code: "WILLS_PROBATE", name: "Wills and Probate", description: "Making a will, inheritance, sorting out the estate of someone who has died." },
    { code: "DEBT_INSOLVENCY", name: "Debt and Insolvency", description: "Owing money you can't pay, debt collectors, bankruptcy, IVAs, a business that can't pay its debts." },
    { code: "REPUTATION_PRIVACY", name: "Reputation and Privacy", description: "Something false said or published about you, misuse of your personal data, data breaches." },
    { code: "PUBLIC_BODIES", name: "Government and Public Bodies", description: "Decisions by a council, government department, school, the NHS or another public body, human rights, planning and pollution." },
    { code: "TAX", name: "Tax", description: "HMRC, tax bills, penalties and investigations, inheritance or capital gains tax." },
    { code: "BUSINESS", name: "Business", description: "Running a company or partnership, disputes with shareholders, partners, suppliers or business customers, commercial contracts." },
    { code: "INTELLECTUAL_PROPERTY", name: "Intellectual Property", description: "Copyright, trade marks, patents and designs, someone copying your work, brand or invention." },
    { code: OTHER_CASE_AREA, name: "Other", description: "Anything else." },
  ],
  PH: [
    { code: "EMPLOYMENT", name: "Labor and Employment", description: "Work, illegal dismissal, unpaid wages or benefits, OFW and seafarer claims, cases at the NLRC or DOLE." },
    { code: "FAMILY", name: "Family", description: "Annulment, legal separation, custody, child support, adoption, violence against women and children." },
    { code: "PROPERTY", name: "Land and Property", description: "Land titles, ejectment, renting, buying or selling property, construction, agrarian reform land." },
    { code: "CONSUMER", name: "Consumer", description: "Defective goods or services, refunds, banks, loans and insurance, problems with a business." },
    { code: "IMMIGRATION", name: "Immigration", description: "Visas, work permits, residency, deportation, the Bureau of Immigration." },
    { code: "CRIMINAL", name: "Criminal", description: "Being charged, arrested or investigated, estafa, bouncing cheques (BP 22), filing a criminal complaint." },
    { code: "WILLS_PROBATE", name: "Wills and Estates", description: "Making a will, inheritance, settling the estate of someone who has died." },
    { code: "REPUTATION_PRIVACY", name: "Online, Privacy and Reputation", description: "Cyber libel, online scams and hacking, misuse of your personal data, something false said about you." },
    { code: "PUBLIC_BODIES", name: "Government and Public Office", description: "Decisions by a government agency or local government, elections, graft complaints, human rights, the environment." },
    { code: "TAX", name: "Tax", description: "BIR assessments, tax penalties and tax cases." },
    { code: "BUSINESS", name: "Business", description: "Running a corporation or partnership, the SEC, commercial contracts, disputes with partners, suppliers or business customers, shipping and energy." },
    { code: "INTELLECTUAL_PROPERTY", name: "Intellectual Property", description: "Copyright, trademarks, patents, someone copying your work, brand or invention." },
    { code: OTHER_CASE_AREA, name: "Other", description: "Anything else." },
  ],
};

/** A code is set once, when the area is made: capitals, digits and underscores. */
export const CASE_AREA_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
export const CASE_AREA_NAME_MAX_LENGTH = 60;
export const CASE_AREA_DESCRIPTION_MAX_LENGTH = 500;
