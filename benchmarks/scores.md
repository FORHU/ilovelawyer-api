# Benchmark score history

| Date | Benchmark | Answers | Overall | Per question | Grader | Moderated |
|---|---|---|---:|---|---|---|
| 2026-09-13 | brackenmoor | 2026-09-13-after-fix | 55.7 | Q1 66, Q2 57, Q3 44 | gpt-5.6-terra | no |
| 2026-09-13 | brackenmoor | 2026-09-12 | 51 | Q1 61, Q2 43, Q3 49 | gpt-5.6-terra | no |
| 2026-09-16 | brackenmoor | 2026-09-16-bm25-off | 73 | Q1 73 | gpt-5.6-terra | no |
| 2026-09-16 | brackenmoor | 2026-09-16-bm25-on | 74 | Q1 74 | gpt-5.6-terra | no |
| 2026-09-16 | brackenmoor | 2026-09-16-bm25-on-no-embed | 65 | Q1 65 | gpt-5.6-terra | no |
| 2026-09-16 | brackenmoor | 2026-09-16-bm25-off-no-embed | 68 | Q1 68 | gpt-5.6-terra | no |
| 2026-09-16 | brackenmoor | 2026-09-16-bm25-on-forced | 50 | Q1 50 | gpt-5.6-terra | no |
| 2026-09-16 | brackenmoor | 2026-09-16-bm25-on-forced-2 | 49 | Q1 49 | gpt-5.6-terra | no |
| 2026-09-21 | jev-citation-validity | 2026-09-21T11-31-10 | 100 | Jev 15/15 vs heuristic 6/15 (40); avg 311ms | hand-labeled | no |
| 2026-09-21 | jev-citation-proposition | 2026-09-21T11-33-24 | 100 | Jev 17/17 vs chat-wonder 16/17 (94); 545ms vs 4628ms | hand-labeled + 1 real row | no |
| 2026-09-21 | jev-message-triage | 2026-09-21T11-31-13 | 100 | 16/16; avg p urgent 98 / routine 4 | hand-labeled | no |
| 2026-09-21 | jev-chat-context | 2026-09-21T11-41-00 | n/a | note adds +20–48% length, no urgency-word change | none (qualitative) | no |
| 2026-09-21 | jev-consultation | 2026-09-21T11-44-25-off / 11-48-13-on | n/a | real worker path 6/6 DONE; triage 3/3 correct; injected only on urgent | none (qualitative) | no |
| 2026-09-21 | brackenmoor | 2026-09-21-newboost-jev-off | 43 | Q1 54, Q2 35, Q3 40 | gpt-5.6-luna | no |
| 2026-09-21 | brackenmoor | 2026-09-21-newboost-jev-on | 38 | Q1 41, Q2 36, Q3 37 | gpt-5.6-luna | no |
| 2026-09-21 | brackenmoor | 2026-09-21-seeded-jev-off | 46.3 | Q1 56, Q2 36, Q3 47 | gpt-5.6-luna | no |
| 2026-09-21 | brackenmoor | 2026-09-21-seeded-jev-on | 34 | Q1 24, Q2 35, Q3 43 | gpt-5.6-luna | no |
| 2026-09-21 | jev-message-triage (urgency + intent) | 2026-09-21T15-15-28 | 89 | urgency 36/38 (95); intent 34/38 (89) — CONSULTATION 12/12, RESEARCH 7/7, PARALEGAL 5/5, ANALYZE 4/4, DOC 2/2, PLEADING 2/4, OTHER 2/4 | hand-labeled | no |
| 2026-09-22 | jev-uk-triage | 2026-09-22T16-21-14 | 100 | intent 48/48 (100); urgency 46/48 (96) — explicit 37/38, implicit 9/10; attachment guard 48/48 | hand-labeled (E&W) | no |
| 2026-09-22 | jev-uk-triage (sharpened urgency Q) | 2026-09-22T16-26 | 100 | intent 48/48 (100); urgency 47/48 (98) — explicit 36/37, implicit 11/11; attachment guard 48/48 | hand-labeled (E&W) | no |
| 2026-09-22 | jev-message-triage (sharpened urgency Q) | 2026-09-22T16-27 | 90 | urgency 48/50 (96) — implicit 15/15 (was 14/15); intent 45/50 (90); guard 21/22 | hand-labeled (PH+UK) | no |
| 2026-09-22 | jev-grounding (absence half) | 2026-09-22T17-33 | 100 | 18/18 — FALSE_ABSENCE 10/10, NOT_SUPPLIED 2/2, CORRECT_ABSENCE 1/1, UNRESOLVED 3/3, NOT_A_CLAIM 2/2; no AI, no DB | grader-harvested | no |
| 2026-09-22 | jev-grounding (full) | 2026-09-22T17-46-57 | 77 | absence 18/18; assertions 20/26 — SUPPORTED 9/9, UNSUPPORTED 7/8, CONTRADICTED 4/9; evidence-kind 18/26; both ship gates PASS (0 false CONTRADICTED after the 0.7 floor) | grader-harvested | no |
