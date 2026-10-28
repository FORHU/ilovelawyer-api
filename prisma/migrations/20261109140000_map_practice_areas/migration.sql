-- Every default practice area routes client requests to a case area of its own kind. On UK, nine
-- new case areas (from IMMIGRATION to INTELLECTUAL_PROPERTY in DEFAULT_CASE_AREAS) take the areas
-- the first five didn't cover; PH gets a list of its own, ready for when it has client cases. Only
-- the generalist areas route OTHER: it takes the cases nothing else fits. Data only: no schema
-- change. A row an admin has already given a case area, or renamed, is left as it is.

-- ── UK ──

-- The new case areas go at the end of the list, skipped if the code or name is already taken.
INSERT INTO "CaseArea" ("id", "country", "code", "name", "description", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'UK', d."code", d."name", d."description", true, top."sortOrder" + d."offset", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('IMMIGRATION', 'Immigration', 'Visas, asylum, the right to live or work in the UK, deportation.', 1),
  ('CRIMINAL', 'Criminal', 'Being questioned, arrested, charged or prosecuted for a crime, or a criminal record.', 2),
  ('WILLS_PROBATE', 'Wills and Probate', 'Making a will, inheritance, sorting out the estate of someone who has died.', 3),
  ('DEBT_INSOLVENCY', 'Debt and Insolvency', 'Owing money you can''t pay, debt collectors, bankruptcy, IVAs, a business that can''t pay its debts.', 4),
  ('REPUTATION_PRIVACY', 'Reputation and Privacy', 'Something false said or published about you, misuse of your personal data, data breaches.', 5),
  ('PUBLIC_BODIES', 'Government and Public Bodies', 'Decisions by a council, government department, school, the NHS or another public body, human rights, planning and pollution.', 6),
  ('TAX', 'Tax', 'HMRC, tax bills, penalties and investigations, inheritance or capital gains tax.', 7),
  ('BUSINESS', 'Business', 'Running a company or partnership, disputes with shareholders, partners, suppliers or business customers, commercial contracts.', 8),
  ('INTELLECTUAL_PROPERTY', 'Intellectual Property', 'Copyright, trade marks, patents and designs, someone copying your work, brand or invention.', 9)
) AS d("code", "name", "description", "offset")
CROSS JOIN (SELECT COALESCE(MAX("sortOrder"), -1) AS "sortOrder" FROM "CaseArea" WHERE "country" = 'UK') AS top
ON CONFLICT DO NOTHING;

-- Other stays last, unless an admin has already moved it.
UPDATE "CaseArea" o
SET "sortOrder" = (SELECT MAX("sortOrder") + 1 FROM "CaseArea" WHERE "country" = 'UK'), "updatedAt" = CURRENT_TIMESTAMP
WHERE o."country" = 'UK' AND o."code" = 'OTHER'
  AND NOT EXISTS (
    SELECT 1 FROM "CaseArea" b
    WHERE b."country" = 'UK'
      AND b."code" NOT IN ('IMMIGRATION', 'CRIMINAL', 'WILLS_PROBATE', 'DEBT_INSOLVENCY', 'REPUTATION_PRIVACY', 'PUBLIC_BODIES', 'TAX', 'BUSINESS', 'INTELLECTUAL_PROPERTY')
      AND b."sortOrder" > o."sortOrder"
  );

-- The UK defaults that had no case area, matched by name whatever its case.
UPDATE "PracticeArea" p
SET "caseArea" = m."code", "updatedAt" = CURRENT_TIMESTAMP
FROM (VALUES
  ('Immigration Law', 'IMMIGRATION'),
  ('Criminal Law', 'CRIMINAL'),
  ('Commercial Litigation', 'BUSINESS'),
  ('Corporate Law', 'BUSINESS'),
  ('Commercial Law', 'BUSINESS'),
  ('Construction Law', 'PROPERTY'),
  ('Contract Law', 'CONSUMER'),
  ('Intellectual Property Law', 'INTELLECTUAL_PROPERTY'),
  ('Data Protection and Privacy Law', 'REPUTATION_PRIVACY'),
  ('Tax Law', 'TAX'),
  ('Banking and Finance Law', 'CONSUMER'),
  ('Insolvency and Restructuring', 'DEBT_INSOLVENCY'),
  ('Wills and Probate', 'WILLS_PROBATE'),
  ('Human Rights Law', 'PUBLIC_BODIES'),
  ('Public and Administrative Law', 'PUBLIC_BODIES'),
  ('Environmental Law', 'PUBLIC_BODIES'),
  ('Competition Law', 'BUSINESS'),
  ('Arbitration and Mediation', 'OTHER'),
  ('Insurance Law', 'CONSUMER'),
  ('Defamation Law', 'REPUTATION_PRIVACY'),
  ('Professional Negligence', 'CONSUMER'),
  ('International Law', 'OTHER')
) AS m("name", "code")
WHERE p."country" = 'UK' AND p."caseArea" IS NULL AND lower(p."name") = lower(m."name")
  AND EXISTS (SELECT 1 FROM "CaseArea" a WHERE a."country" = 'UK' AND a."code" = m."code");

-- ── PH ──

-- PH's case areas, in picker order after any an admin has already made.
INSERT INTO "CaseArea" ("id", "country", "code", "name", "description", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'PH', d."code", d."name", d."description", true, top."sortOrder" + d."offset", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('EMPLOYMENT', 'Labor and Employment', 'Work, illegal dismissal, unpaid wages or benefits, OFW and seafarer claims, cases at the NLRC or DOLE.', 1),
  ('FAMILY', 'Family', 'Annulment, legal separation, custody, child support, adoption, violence against women and children.', 2),
  ('PROPERTY', 'Land and Property', 'Land titles, ejectment, renting, buying or selling property, construction, agrarian reform land.', 3),
  ('CONSUMER', 'Consumer', 'Defective goods or services, refunds, banks, loans and insurance, problems with a business.', 4),
  ('IMMIGRATION', 'Immigration', 'Visas, work permits, residency, deportation, the Bureau of Immigration.', 5),
  ('CRIMINAL', 'Criminal', 'Being charged, arrested or investigated, estafa, bouncing cheques (BP 22), filing a criminal complaint.', 6),
  ('WILLS_PROBATE', 'Wills and Estates', 'Making a will, inheritance, settling the estate of someone who has died.', 7),
  ('REPUTATION_PRIVACY', 'Online, Privacy and Reputation', 'Cyber libel, online scams and hacking, misuse of your personal data, something false said about you.', 8),
  ('PUBLIC_BODIES', 'Government and Public Office', 'Decisions by a government agency or local government, elections, graft complaints, human rights, the environment.', 9),
  ('TAX', 'Tax', 'BIR assessments, tax penalties and tax cases.', 10),
  ('BUSINESS', 'Business', 'Running a corporation or partnership, the SEC, commercial contracts, disputes with partners, suppliers or business customers, shipping and energy.', 11),
  ('INTELLECTUAL_PROPERTY', 'Intellectual Property', 'Copyright, trademarks, patents, someone copying your work, brand or invention.', 12),
  ('OTHER', 'Other', 'Anything else.', 13)
) AS d("code", "name", "description", "offset")
CROSS JOIN (SELECT COALESCE(MAX("sortOrder"), -1) AS "sortOrder" FROM "CaseArea" WHERE "country" = 'PH') AS top
ON CONFLICT DO NOTHING;

-- The PH defaults that had no case area, matched by name whatever its case.
UPDATE "PracticeArea" p
SET "caseArea" = m."code", "updatedAt" = CURRENT_TIMESTAMP
FROM (VALUES
  ('Family Law', 'FAMILY'),
  ('Labor and Employment Law', 'EMPLOYMENT'),
  ('Criminal Law', 'CRIMINAL'),
  ('Civil Law', 'OTHER'),
  ('Corporate Law', 'BUSINESS'),
  ('Commercial Law', 'BUSINESS'),
  ('Property and Real Estate Law', 'PROPERTY'),
  ('Immigration Law', 'IMMIGRATION'),
  ('Tax Law', 'TAX'),
  ('Intellectual Property Law', 'INTELLECTUAL_PROPERTY'),
  ('Data Privacy Law', 'REPUTATION_PRIVACY'),
  ('Cybercrime Law', 'REPUTATION_PRIVACY'),
  ('Commercial Litigation', 'BUSINESS'),
  ('Civil Litigation', 'OTHER'),
  ('Administrative Law', 'PUBLIC_BODIES'),
  ('Constitutional Law', 'PUBLIC_BODIES'),
  ('Election Law', 'PUBLIC_BODIES'),
  ('Environmental Law', 'PUBLIC_BODIES'),
  ('Banking and Finance Law', 'CONSUMER'),
  ('Insurance Law', 'CONSUMER'),
  ('Construction Law', 'PROPERTY'),
  ('Energy Law', 'BUSINESS'),
  ('Maritime and Admiralty Law', 'BUSINESS'),
  ('Wills and Estate Settlement', 'WILLS_PROBATE'),
  ('Arbitration and Mediation', 'OTHER'),
  ('Consumer Protection Law', 'CONSUMER'),
  ('Human Rights Law', 'PUBLIC_BODIES'),
  ('Land Registration and Titling', 'PROPERTY'),
  ('Agrarian Reform Law', 'PROPERTY'),
  ('Anti-Graft and Corruption Law', 'PUBLIC_BODIES')
) AS m("name", "code")
WHERE p."country" = 'PH' AND p."caseArea" IS NULL AND lower(p."name") = lower(m."name")
  AND EXISTS (SELECT 1 FROM "CaseArea" a WHERE a."country" = 'PH' AND a."code" = m."code");
