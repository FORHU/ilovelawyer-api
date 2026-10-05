import type { FindingTag } from "@prisma/client";

type EditableFields = { label: string; detail: string | null; tag: FindingTag | null };

/** Whether a PATCH changes what the finding says — its label, detail or tag. Reordering
 * (position) and the notes marker don't count. An AI row a lawyer has edited this way is theirs:
 * replaceAiFindings keeps it through a regeneration (CaseFinding.lawyerEditedAt). */
export function isLawyerEdit(existing: EditableFields, data: Partial<EditableFields>): boolean {
  return (
    (data.label !== undefined && data.label !== existing.label) ||
    (data.detail !== undefined && (data.detail ?? null) !== existing.detail) ||
    (data.tag !== undefined && (data.tag ?? null) !== existing.tag)
  );
}
