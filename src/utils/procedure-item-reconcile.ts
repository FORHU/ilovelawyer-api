export interface ExistingAiItem {
  id: string;
  kind: string;
  label: string;
  done: boolean;
  sourceLabel: string | null;
}

export interface IncomingAiItem {
  kind: string;
  label: string;
  sourceLabel: string | null;
}

export interface ProcedureItemPlan {
  create: IncomingAiItem[];
  /** Rows the new run still recommends: kept as-is (so `done` survives), source refreshed. */
  update: { id: string; sourceLabel: string | null }[];
  remove: string[];
}

const key = (kind: string, label: string) => `${kind}|${label.trim().toLowerCase()}`;

/**
 * A regeneration must not erase the lawyer's progress. AI rows are matched to the new run by
 * kind + label: a match is kept (its ticked `done` state survives), a new label is created, and a
 * row the run no longer recommends is dropped only if it's still open — a ticked one is history
 * the lawyer earned, so it stays. Replaces the old delete-all-then-insert, which un-ticked
 * everything on every refresh.
 */
export function planAiProcedureItems(existing: ExistingAiItem[], incoming: IncomingAiItem[]): ProcedureItemPlan {
  const existingByKey = new Map(existing.map((row) => [key(row.kind, row.label), row]));
  const incomingKeys = new Set(incoming.map((item) => key(item.kind, item.label)));

  const create: IncomingAiItem[] = [];
  const update: ProcedureItemPlan["update"] = [];
  for (const item of incoming) {
    const match = existingByKey.get(key(item.kind, item.label));
    if (!match) create.push(item);
    else if (match.sourceLabel !== item.sourceLabel) update.push({ id: match.id, sourceLabel: item.sourceLabel });
  }
  const remove = existing.filter((row) => !row.done && !incomingKeys.has(key(row.kind, row.label))).map((row) => row.id);
  return { create, update, remove };
}
