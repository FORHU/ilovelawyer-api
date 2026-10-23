import NoteRepo from "../repositories/note.repository";
import HttpError from "../utils/http-error";
import SecurityAuditSvc from "./security-audit.service";
import type { WorkspaceScope } from "../utils/workspace";

interface NoteRecord {
  id: string;
  date: Date;
  body: string;
}

/** Serializes to the date-only ("yyyy-MM-dd") shape the Calendar frontend expects — a Note has no time component, unlike an Event. */
function toNoteDto(note: NoteRecord) {
  return {
    id: note.id,
    date: note.date.toISOString().slice(0, 10),
    body: note.body,
  };
}

export default class NoteSvc {
  static async list(scope: WorkspaceScope, userId: string, filters: { from?: string; to?: string }) {
    const notes = await NoteRepo.findMany(scope, userId, filters);
    return notes.map(toNoteDto);
  }

  static async create(scope: WorkspaceScope, userId: string, body: { date?: string; body?: string }) {
    if (!body.date) throw new HttpError("date is required", 400);
    if (!body.body || !body.body.trim()) throw new HttpError("body is required", 400);

    const note = await NoteRepo.create(scope, userId, {
      date: new Date(`${body.date}T00:00:00.000Z`),
      body: body.body.trim(),
    });
    return toNoteDto(note);
  }

  static async updateById(id: string, scope: WorkspaceScope, userId: string, body: { date?: string; body?: string }) {
    if (body.body !== undefined && !body.body.trim()) throw new HttpError("body is required", 400);

    const data: { date?: Date; body?: string } = {};
    if (body.date !== undefined) data.date = new Date(`${body.date}T00:00:00.000Z`);
    if (body.body !== undefined) data.body = body.body.trim();

    const result = await NoteRepo.updateById(id, scope, userId, data);
    if (result.count === 0) throw new HttpError("Note not found", 404);
    return { success: true };
  }

  static async deleteById(id: string, scope: WorkspaceScope, userId: string) {
    const result = await NoteRepo.deleteById(id, scope, userId);
    if (result.count === 0) throw new HttpError("Note not found", 404);
    await SecurityAuditSvc.record({ action: "note.deleted", actorId: userId, organizationId: scope.organizationId, targetType: "note", targetId: id });
  }
}
