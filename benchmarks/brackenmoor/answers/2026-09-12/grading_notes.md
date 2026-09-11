# Grading notes — Brackenmoor benchmark (grader: Claude, against the bundle text)

Rubric (per question, /100), derived from D21 marking guidance:
- A. Grounding & citation discipline — 25 (every factual assertion pinned to doc/para; no unsupported facts)
- B. Contradiction identification — 20 (distinct contradictions, which document is more probative and why)
- C. Legal accuracy & authority — 20 (correct statute/case; no invented authority; verified links)
- D. Reasoning in the alternative / ambiguity flagged — 15
- E. Assertion vs witness vs document vs established — 10
- F. Determinative silences identified — 5
- G. Completeness across sub-questions — 5

## Q1 — Criminal liability (55 tool calls, 6.1 min, 8,395 words, 15 docs cited, 88 pinpoints, 0 gated links)

Strengths
- Correct statutory structure for CMCHA 2007 s.1/s.8, HSWA s.3/s.37, CJA 2003 ss.119/120, CPA 1865 s.3, CJPOA s.34 — all fetched from legislation.gov.uk and linked to section pages.
- Bilta [2015] UKSC 23 and Singularis [2019] UKSC 50 fetched and read (grep + paragraphs); R v Sellu [2016] EWCA Crim 1716 used correctly for GNM elements. No invented authority.
- Turnstile log (D13 Part 1) handled precisely: proves card presentation, not presence; biometrics/anti-passback disabled; double-tap not over-read.
- Crane data logger (D14 Part 2) correctly identified as least-challengeable, and correctly limited: proves the event, not the decision-maker.
- Danecourt "three conditions" (D20.1 §6) correctly analysed as multiple-causation that helps the Crown on the corporate count and helps Ferris on the personal count.
- s.34: distinguishes silence on undisclosed forensic material (no inference) from facts actually advanced (no inference available) — correct.
- Honest gap flag: "D01 … paragraphs 1-21 but not paragraph 25 … cannot safely state" rather than inventing.
- 16 concrete further-enquiry items, each pinned to bundle evidence.

Defects
1. **D10 never cited.** The Ferris email chain (10.2 "deal with this. I don't want it coming back to me"; 10.5 "I don't need to know the detail… find a way through it"; disputed 10.6) is the strongest senior-management/knowledge evidence in the bundle and is absent from 1.1 and 1.5. D20.3 (attendance note: Ferris knew by Tuesday afternoon) also not engaged. The statement "no direct admissible evidence that he knew" is therefore under-supported — it should have been "the direct evidence is D10.6/D20.3, whose admissibility turns on the privilege/iniquity issue".
2. **D01 para 25 not seen** — model fetched D01 through the relevance-filtered chunk ids and did not re-fetch the whole document. System issue (see report), but the answer lost the Pyle-payments/late-disclosure point and the D02 §5.3 coroner concern.
3. D02 (coroner PIR) not cited at all — misses Pyle payments concern (5.3), Article 2 history, r.22 privilege position of Delacroix-Hale.
4. Pronoun error: Dr Vantrease is "his" in D20.1 §§2, 8; answer uses "she/her" throughout. Not material to the analysis, but it is an unsupported assertion.
5. Contradictions are handled where the question forces them but not enumerated; Kettleborough's own "still lifting??" wording inconsistency (D06 §13) not used.
6. Cosmetic: final HSWA s.3 anchor swallowed the bundle-citation string into the link label (format_legal_citation_links greedy regex).

Scores: A 20 | B 14 | C 18 | D 12 | E 9 | F 4 | G 3  → **80/100**

## Q2 — Commercial & insurance (60 tool calls = cap hit, 7.2 min, 8,566 words, 12 docs cited, 26 links / 20 distinct, 0 gated, 4 case links HTTP-verified)

Strengths
- 2.1: spots that Coldbrook's "five clear days" reading is arithmetically impossible on the bundle's own dates (12→15 Dec leaves two clear days); correctly flags that cl. 4.7.4 and IA/18's attachments are not in the bundle, so the "invalid application" case cannot be decided; two-analysis fork on fraud (not proved / proved & connected), with the £610k severable from the rest.
- 2.2: cl. 1.7 "shall be of no effect" → default notice ineffective; 19 Dec premature vs 22 Dec expiry; cl. 8.4.4 "reasonably believes" = actual + objectively reasonable belief at the time; correctly refuses to let the 6 May 2024 metadata report backfill a 19 Dec 2023 belief, while noting the 8 Dec notice already alleged the 13 Nov creation; cl. 8.1 "sole means" likely excludes common-law acceptance, with the counter-argument stated; consequences both ways.
- 2.3: IA 2015 ss.3/7/8/10/11/12/16/17 all fetched and pinned to section pages; broker email + Pilbeam note as knowledge/inducement answer; adverse inference from the missing email despite 7-year retention; s.11(3) burden correctly placed on Meridian and assessed as "formidable"; Versloot [2016] UKSC 45 fetched and applied — TWDC-BW-07 is not a collateral lie; s.17 transparency analysed without treating the missing statement as dispositive; election/waiver chronology laid out with the reservation letter's limits.
- 2.4: TP(RAI)A 2010 s.1, CDM regs 13/15, FAA 1976 ss.1/1A/2, Limitation Act ss.11/12 fetched; held-covered email analysed for authority/condition-precedent; direct claim against Meridian framed on retained control, Woodland v Essex [2013] UKSC 66 correctly relegated; **limitation computed against today's date: 14 Nov 2026 (~2 months)** with a "24 hours / few days" action list.
- Catches that the question's "nine months" is the 6 May 2024→2 Feb 2025 interval, not the full 14 months of funding.

Defects
1. **Budget exhausted → forced completion.** "Not Yet Reviewed" lists D08, D11, D12, D13, D14, D15 Pt 4, D17 balance. The answer nonetheless cites D08/D11/D12/D13/D14 from the inline ranked chunks, so the list is over-cautious, but it is an honest signal that the second half of the bundle was not read in full.
2. **Named payment/termination authorities not resolved.** Grove/Bexheat, SG South, ISG v Seevic, Reinwood are discussed "at the level of principle" with no citation or link; only Gosvenor [2018] EWCA Civ 2695 and a 2026 TCC case (Oakland Wantage v Stepnell — verified) were fetched. The question named them; a marker would expect them cited.
3. Exclusion 4 (deliberate act of a director) only mentioned in passing; s.3(4)/(5)(b) IA 2015 (insurer's knowledge) argued in substance but the subsections are not identified.
4. Vellacott Marr dual-role conflict noted but not developed as an estoppel/attribution point.
5. Minor: D17 Part 7 cited as "[D17 p 4]" (page not part); the interim-cover analysis does not address whether Brackenridge's *own* denial of broker authority is itself evidence the bundle leaves undetermined (it does — flagged only implicitly).

Scores: A 21 | B 15 | C 15 | D 13 | E 8 | F 4 | G 4  → **80/100**

## Q3 — Admissibility, privilege, disclosure, employment (6.5 min, 10,443 words, 10 docs cited, 22 links / 15 distinct, 0 gated, 3 case links HTTP-verified, no cap hit)

Strengths
- Every sub-question answered with a forum-by-forum table (Crown Court / TCC / ET / coroner) as the question demanded.
- 3.1: legal advice privilege correctly found prima facie; iniquity exception correctly framed as "in furtherance of", not "about" wrongdoing, using Al Sadeq v Dechert [2024] EWCA Civ 28 and Jardine Strategic v Oasis [2025] UKPC 34 (both fetched, both verified); CPR 31.20 "obvious mistake" weighed both ways with the D10.9 disclosure failures counted against Meridian; concrete TCC order and Halloway Brant steps (conflict review, witness/advocate risk, preservation).
- 3.2: covert private recording not excluded per se; s.78 correctly confined to Crown Court; WP objection assessed weak with the HR opening ("you weren't our employee"); unambiguous-impropriety applied to 03:04; three readings at 02:40 treated as unsafe; severability — correct.
- 3.3: **catches the "eleven days after the disclosure" inconsistency** (16/17 Nov → 1 Dec is 14–15 days) and reasons in the alternative; Art 5/6(1)(f)/13/35 applied to the memo's own words; ET admissibility handled as weight; s.47B detriment with s.48 burden on the employer.
- 3.4: s.116 (death; outside UK) and s.121 multiple hearsay correctly applied to the SMS and its "Gareth said" layer; "szef" ambiguity and handset-operator limit noted; Ashgrove-Pike solicitors' assertions treated as double hearsay of little weight.
- 3.5: declaration vs G4 inconsistency stated precisely (uplift existed at countersignature 14 Feb 2024; declaration 8 Aug 2024); 61% dependence = weight not admissibility; CPR 35.4 late permission handled proportionately; para 2.5 reliance on the contested transcript flagged with a supplemental-report order; para 1.7 ultimate-issue point correct and contrasted with Danecourt §8.
- 3.6: s.43B/43F/43J/47B/48/49/103A fetched; the eight causation indicators (timing, Ferris reply, no process, minute defects, resignation date, advert, dismissal-letter gag) marshalled; clause 9 void under s.43J and detriment analysed with the Head of HR / cc Ferris point.

Defects
1. **D20.3 never read.** The answer says its "exact contents must be inspected" and reasons over three hypotheticals — but the full attendance note is in the bundle (D20 p.5). So 3.1 misses: Ferris's follow-up "what is the position if the certificate goes to HSE and nobody says anything about when it was made" (the strongest iniquity-exception fact), the "note to file / COLP" the question expressly asks about, and the planted contradiction that D10 says return of 10.6 was demanded on 11 Apr 2024 while D20.3 says Meridian "has not sought the return of item 10.6". Same retrieval cause as Q1's D01 para 25.
2. **s.103A burden of proof not addressed.** The question asks about burden where there is no qualifying service; the answer only says qualifying service is unnecessary. The point that the claimant then bears the burden of proving the s.103A reason (Smith v Hayle / Kuzel v Roche line) is absent.
3. **Remedies thin.** Declines to state that s.103A compensation is uncapped (s.124(1A)), the 25% ACAS uplift, or injury-to-feelings for detriment, citing lack of a "verified statutory source" — honest, but a marker expects these.
4. Named authorities largely uncited: Eustice, Ablyazov, Al Fayed, Vaughan v Lewisham, Gardiner & Theobald, Toth v Jarman, EXP v Barker, Stockwell, Pora — only Cox and Railton mentioned (via Jardine). Substance is right; citation coverage is not.
5. DPA 2018 ss.35–40 trap not caught (those are Part 3 law-enforcement provisions and do not apply to a private employer); the answer hedges instead of saying so. s.117 CJA 2003 (business records) not identified for the Met Office / Halbrook records; s.114(1)(d) not mentioned.
6. Writing glitch at 3.3.A ("eleven days after Ms Raghunathan's 20 November? The bundle actually identifies…") — visible self-correction left in the text.

Scores: A 18 | B 13 | C 13 | D 13 | E 8 | F 3 | G 3  → **71/100**

## Overall: (80 + 80 + 71) / 3 = **77 / 100**
