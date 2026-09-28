-- AI-drafted findings were bulk-inserted without a FINDING graph node (only manual adds called
-- CaseGraphSvc.ensureNode), so the Legal Issues panel, which reads the graph-view projection,
-- never showed them. CaseFindingRepo.replaceAiFindings now writes the node; this registers one
-- for every existing finding that lacks it.
INSERT INTO "CaseGraphNode" ("id", "caseId", "nodeType", "refId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::TEXT, f."caseId", 'FINDING', f."id", NOW(), NOW()
FROM "CaseFinding" f
WHERE NOT EXISTS (
    SELECT 1 FROM "CaseGraphNode" n WHERE n."nodeType" = 'FINDING' AND n."refId" = f."id"
);
