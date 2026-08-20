/** Regular and nationwide special non-working holidays used by the PH deadline engine.
 * Variable dates (Holy Week, Chinese New Year, National Heroes Day) are listed per year. */
export const PH_FIXED_HOLIDAYS: { month: number; day: number; name: string }[] = [
  { month: 1, day: 1, name: "New Year's Day" },
  { month: 2, day: 25, name: "EDSA People Power Revolution Anniversary" },
  { month: 4, day: 9, name: "Araw ng Kagitingan" },
  { month: 5, day: 1, name: "Labor Day" },
  { month: 6, day: 12, name: "Independence Day" },
  { month: 8, day: 21, name: "Ninoy Aquino Day" },
  { month: 11, day: 1, name: "All Saints' Day" },
  { month: 11, day: 30, name: "Bonifacio Day" },
  { month: 12, day: 8, name: "Feast of the Immaculate Conception" },
  { month: 12, day: 25, name: "Christmas Day" },
  { month: 12, day: 30, name: "Rizal Day" },
  { month: 12, day: 31, name: "Last Day of the Year" },
];

/** month is 1-based. */
export const PH_VARIABLE_HOLIDAYS: Record<number, { month: number; day: number; name: string }[]> = {
  2026: [
    { month: 2, day: 17, name: "Chinese New Year" },
    { month: 4, day: 2, name: "Maundy Thursday" },
    { month: 4, day: 3, name: "Good Friday" },
    { month: 4, day: 4, name: "Black Saturday" },
    { month: 8, day: 31, name: "National Heroes Day" },
  ],
  2027: [
    { month: 2, day: 6, name: "Chinese New Year" },
    { month: 3, day: 25, name: "Maundy Thursday" },
    { month: 3, day: 26, name: "Good Friday" },
    { month: 3, day: 27, name: "Black Saturday" },
    { month: 8, day: 30, name: "National Heroes Day" },
  ],
  2028: [
    { month: 1, day: 26, name: "Chinese New Year" },
    { month: 4, day: 13, name: "Maundy Thursday" },
    { month: 4, day: 14, name: "Good Friday" },
    { month: 4, day: 15, name: "Black Saturday" },
    { month: 8, day: 28, name: "National Heroes Day" },
  ],
};

export interface DeadlineRule {
  code: string;
  label: string;
  days: number;
  ruleSource: string;
}

export const PH_DEADLINE_RULES: DeadlineRule[] = [
  {
    code: "answer_civil",
    label: "Answer to complaint (ordinary civil action)",
    days: 15,
    ruleSource: "1997 Rules of Civil Procedure, Rule 11, Sec. 1",
  },
  {
    code: "answer_summons_extraterritorial",
    label: "Answer after extraterritorial service",
    days: 60,
    ruleSource: "1997 Rules of Civil Procedure, Rule 11, Sec. 2",
  },
  {
    code: "notice_of_appeal",
    label: "Notice of appeal",
    days: 15,
    ruleSource: "1997 Rules of Civil Procedure, Rule 41, Sec. 2",
  },
  {
    code: "motion_reconsideration",
    label: "Motion for reconsideration / new trial",
    days: 15,
    ruleSource: "1997 Rules of Civil Procedure, Rule 37, Sec. 1",
  },
  {
    code: "rule65_certiorari",
    label: "Petition for certiorari, prohibition, or mandamus",
    days: 60,
    ruleSource: "1997 Rules of Civil Procedure, Rule 65, Sec. 4",
  },
  {
    code: "nlrc_appeal",
    label: "Appeal from Labor Arbiter to NLRC",
    days: 10,
    ruleSource: "NLRC Rules of Procedure, Rule VI, Sec. 1",
  },
];
