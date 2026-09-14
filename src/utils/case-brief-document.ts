import { FindingCategory } from "@prisma/client";
import { AI_FINDING_NOTE, AI_PROCEDURE_NOTE } from "../constants";
import type { CaseSnapshotResult } from "../services/case-snapshot.service";
import type { ReconstructionClaim } from "./case-reconstruction-claims-parse";
import type { RedTeamClaim } from "./red-team-claims-parse";

export type BriefBlock =
  | { type: "heading1"; text: string }
  | { type: "heading2"; text: string }
  | { type: "paragraph"; text: string; italic?: boolean }
  | { type: "notGenerated"; reason?: string }
  | { type: "table"; headers: string[]; rows: string[][] };

export interface BriefSection {
  title: string;
  blocks: BriefBlock[];
}

export interface BriefDocument {
  cover: {
    caseName: string;
    actionType: string | null;
    jurisdiction: string | null;
    generatedAt: Date;
    lastRefreshedAt: Date | null;
  };
  sections: BriefSection[];
}

const ATTRIBUTION_HEADERS = ["Statement", "Category", "Source"];

const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  LEGAL_ISSUE: "Legal Issues",
  STRENGTH: "Strengths",
  WEAKNESS: "Weaknesses",
  ATTACK_STRATEGY: "Attack Strategies",
  DEFENSE_STRATEGY: "Defense Strategies",
};

const FINDING_CATEGORY_ORDER: FindingCategory[] = [
  "LEGAL_ISSUE",
  "STRENGTH",
  "WEAKNESS",
  "ATTACK_STRATEGY",
  "DEFENSE_STRATEGY",
];

function notGenerated(reason?: string): BriefBlock {
  return { type: "notGenerated", reason };
}

function paragraphsFrom(text: string): BriefBlock[] {
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => ({ type: "paragraph", text }) as BriefBlock);
}

/** `reconstruction.claims`/`redTeamAssessment.claims` are `Prisma.JsonValue` at the type level —
 * never trust the shape blindly, since a hand-edited narrative (see CaseReconstructionRepo)
 * clears claims to null, and a malformed row should degrade to being skipped, not crash the
 * export. */
function isAttributionClaim(row: unknown): row is ReconstructionClaim | RedTeamClaim {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.text === "string" &&
    (r.category === "GROUNDED" || r.category === "INFERENCE" || r.category === "UNSUPPORTED") &&
    (r.sourceLabel === null || typeof r.sourceLabel === "string")
  );
}

function attributionRows(claims: unknown): string[][] | null {
  if (!Array.isArray(claims)) return null;
  const rows = claims.filter(isAttributionClaim).map((c) => [c.text, c.category, c.sourceLabel ?? "—"]);
  return rows.length > 0 ? rows : null;
}

/** Trailing "(AI — grounded in: …)" tag for an AI-authored row grounded in a specific document.
 * Manual rows, and AI rows the model didn't attribute to a document, get no tag at all — this is
 * the AI-vs-manual distinction the ticket asks to keep, without inventing a "manual" label. */
function aiTag(notes: string | null, aiMarker: string, sourceLabel: string | null): string {
  if (notes !== aiMarker || !sourceLabel) return "";
  return ` (AI — grounded in: ${sourceLabel})`;
}

export function buildBriefDocument(snapshot: CaseSnapshotResult): BriefDocument {
  const sections: BriefSection[] = [];

  const reconstruction = snapshot.reconstruction;

  // Facts (General register)
  {
    const narrative = reconstruction?.narrative?.trim();
    sections.push({
      title: "Facts",
      blocks: narrative ? paragraphsFrom(narrative) : [notGenerated()],
    });
  }

  // For the Court / From the Other Side
  {
    const court = reconstruction?.narrativeCourt?.trim();
    const opposing = reconstruction?.narrativeOpposing?.trim();
    sections.push({
      title: "For the Court / From the Other Side",
      blocks: [
        { type: "heading2", text: "For the Court" },
        ...(court ? paragraphsFrom(court) : [notGenerated()]),
        { type: "heading2", text: "From the Other Side" },
        ...(opposing ? paragraphsFrom(opposing) : [notGenerated()]),
      ],
    });
  }

  // Gaps + Attribution table (one section, per the plan — a gap list plus the reconstruction's
  // sentence-level GROUNDED/INFERENCE/UNSUPPORTED attribution, not "Claims" — see CONTEXT.md).
  {
    const gaps = reconstruction?.gaps ?? [];
    const gapBlocks: BriefBlock[] =
      gaps.length > 0 ? gaps.map((g) => ({ type: "paragraph", text: g }) as BriefBlock) : [notGenerated()];

    const rows = attributionRows(reconstruction?.claims);
    const attributionBlocks: BriefBlock[] = rows
      ? [{ type: "table", headers: ATTRIBUTION_HEADERS, rows }]
      : [notGenerated()];

    sections.push({
      title: "Gaps & Attribution",
      blocks: [
        { type: "heading2", text: "Gaps" },
        ...gapBlocks,
        { type: "heading2", text: "Attribution" },
        ...attributionBlocks,
      ],
    });
  }

  // Issues / Strengths / Weaknesses / Attack / Defense
  {
    const findingsByCategory = new Map<FindingCategory, typeof snapshot.findings>();
    for (const category of FINDING_CATEGORY_ORDER) findingsByCategory.set(category, []);
    for (const finding of snapshot.findings) {
      findingsByCategory.get(finding.category)?.push(finding);
    }

    const blocks: BriefBlock[] = [];
    for (const category of FINDING_CATEGORY_ORDER) {
      blocks.push({ type: "heading2", text: FINDING_CATEGORY_LABELS[category] });
      const items = findingsByCategory.get(category) ?? [];
      if (items.length === 0) {
        blocks.push(notGenerated());
        continue;
      }
      for (const item of items) {
        const tag = aiTag(item.notes, AI_FINDING_NOTE, item.sourceLabel);
        const notesText = item.notes && item.notes !== AI_FINDING_NOTE ? ` — ${item.notes}` : "";
        blocks.push({ type: "paragraph", text: `${item.label}${notesText}${tag}` });
      }
    }

    sections.push({ title: "Issues, Strengths, Weaknesses, Attack & Defense", blocks });
  }

  // Recommended Approach (STRATEGY)
  {
    const strategyItems = snapshot.procedure.items.filter((i) => i.kind.trim().toUpperCase() === "STRATEGY");
    const blocks: BriefBlock[] =
      strategyItems.length === 0
        ? [notGenerated()]
        : strategyItems.map((item) => {
            const tag = aiTag(item.notes, AI_PROCEDURE_NOTE, item.sourceLabel);
            const notesText = item.notes && item.notes !== AI_PROCEDURE_NOTE ? ` — ${item.notes}` : "";
            return { type: "paragraph", text: `${item.label}${notesText}${tag}` };
          });

    sections.push({ title: "Recommended Approach", blocks });
  }

  // Red Team memo + Attribution table
  {
    const redTeam = snapshot.redTeamAssessment;
    const content = redTeam?.content?.trim();
    const rows = attributionRows(redTeam?.claims);
    const blocks: BriefBlock[] = content
      ? [
          ...paragraphsFrom(content),
          { type: "heading2", text: "Attribution" },
          rows ? { type: "table", headers: ATTRIBUTION_HEADERS, rows } : notGenerated(),
        ]
      : [notGenerated()];

    sections.push({ title: "Red Team", blocks });
  }

  // Contradictions
  {
    const documentNameById = new Map(snapshot.documents.map((d) => [d.id, d.name]));
    const contradictions = snapshot.evidence.contradictions;
    const blocks: BriefBlock[] =
      contradictions.length === 0
        ? [notGenerated()]
        : [
            {
              type: "table",
              headers: ["Fact", "Document A", "Value A", "Document B", "Value B", "Confidence"],
              rows: contradictions.map((c) => [
                c.factKey,
                documentNameById.get(c.leftDocumentId) ?? c.leftDocumentId,
                c.leftValue,
                documentNameById.get(c.rightDocumentId) ?? c.rightDocumentId,
                c.rightValue,
                c.confidence.toFixed(2),
              ]),
            },
          ];

    sections.push({ title: "Contradictions", blocks });
  }

  // Citation checks
  {
    const citations = snapshot.law.citations;
    const blocks: BriefBlock[] =
      citations.length === 0
        ? [notGenerated()]
        : [
            {
              type: "table",
              headers: ["Quoted Text", "Cited Reference", "Status", "Resolved Authority"],
              rows: citations.map((c) => [
                c.quotedText,
                c.citedReference ?? "—",
                c.status,
                c.resolvedAuthority?.title ?? "Unresolved",
              ]),
            },
          ];

    sections.push({ title: "Citation Checks", blocks });
  }

  // Exhibit list — only documents explicitly marked isExhibit, never every uploaded document.
  {
    const exhibits = snapshot.documents.filter((d) => d.isExhibit);
    const blocks: BriefBlock[] =
      exhibits.length === 0
        ? [notGenerated("No documents marked as exhibits.")]
        : [
            {
              type: "table",
              headers: ["Document", "Status"],
              rows: exhibits.map((d) => [d.name, d.ragStatus]),
            },
          ];

    sections.push({ title: "Exhibit List", blocks });
  }

  return {
    cover: {
      caseName: snapshot.case.caseName,
      actionType: snapshot.case.actionType,
      jurisdiction: snapshot.case.jurisdiction,
      generatedAt: new Date(),
      lastRefreshedAt: snapshot.lastRefreshedAt,
    },
    sections,
  };
}
