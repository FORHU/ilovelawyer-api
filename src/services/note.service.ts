import NoteRepo from "../repositories/note.repository";
import HttpError from "../utils/http-error";

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
  static async list(organizationId: string, userId: string, filters: { from?: string; to?: string }) {
    const notes = await NoteRepo.findMany(organizationId, userId, filters);
    return notes.map(toNoteDto);
  }

  static async create(organizationId: string, userId: string, body: { date?: string; body?: string }) {
    if (!body.date) throw new HttpError("date is required", 400);
    if (!body.body || !body.body.trim()) throw new HttpError("body is required", 400);

    const note = await NoteRepo.create(organizationId, userId, {
      date: new Date(`${body.date}T00:00:00.000Z`),
      body: body.body.trim(),
    });
    return toNoteDto(note);
  }
}
