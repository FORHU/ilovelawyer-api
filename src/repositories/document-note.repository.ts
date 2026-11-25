import { RagStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import { openIntakeField, sealIntakeField } from "../utils/intake-field-crypto";

/** Bound into the sealed value, as IntakeMessage's labels are. */
export const DOCUMENT_CLIENT_NOTE = "Document.clientNote";

export const sealDocumentNote = (plain: string): string => sealIntakeField(plain, DOCUMENT_CLIENT_NOTE, true) as string;

/** A stored note, opened: null when there's none, or it's sealed and can't be opened (logged). */
export const openDocumentNote = (stored: string | null | undefined): string | null => (stored ? (openIntakeField(stored, DOCUMENT_CLIENT_NOTE) ?? null) : null);

/** At most this many notes are drafted for one case in one go (a bulk upload waits for the next). */
const DRAFT_BATCH = 10;

/** The client's notes on their documents (Document.clientNote): sealed on the way in, opened on the
 * way out. */
export default class DocumentNoteRepo {
  /** A case's read documents with no note yet, newest first: the ones the AI may draft one for. */
  static async listNeedingDraft(caseId: string) {
    return prisma.document.findMany({
      where: { caseId, status: "ACTIVE", ragStatus: RagStatus.READY, clientNoteBy: null },
      select: { id: true, name: true, category: true },
      orderBy: { createdAt: "desc" },
      take: DRAFT_BATCH,
    });
  }

  /** Saves the AI's draft, unless the client wrote a note meanwhile (never overwritten). A null
   * draft (nothing useful to say) is saved as tried, so the document isn't sent to the AI again. */
  static async saveDraft(documentId: string, note: string | null): Promise<boolean> {
    const { count } = await prisma.document.updateMany({
      where: { id: documentId, clientNoteBy: null },
      data: { clientNote: note ? sealDocumentNote(note) : null, clientNoteBy: "AI" },
    });
    return count === 1;
  }

  /** The client's own note, replacing any draft. Empty clears it, and stays the client's: the AI
   * doesn't draft again. False when the document isn't on this case. */
  static async saveClientNote(documentId: string, caseId: string, note: string): Promise<boolean> {
    const { count } = await prisma.document.updateMany({
      where: { id: documentId, caseId, status: "ACTIVE" },
      data: { clientNote: note ? sealDocumentNote(note) : null, clientNoteBy: "CLIENT" },
    });
    return count === 1;
  }
}
