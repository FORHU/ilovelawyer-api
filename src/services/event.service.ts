import EventRepo from "../repositories/event.repository";
import HttpError from "../utils/http-error";

function inferEventType(title?: string, description?: string): string {
  const typeMatch = description?.match(/\[type:(meeting|appointment|hearing|deposition)\]/);
  if (typeMatch) return typeMatch[1];
  const text = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  if (text.includes("hearing")) return "hearing";
  if (text.includes("deposition")) return "deposition";
  if (text.includes("appointment")) return "appointment";
  return "meeting";
}

function getEventStatus(e: any): string {
  if (e.status === "cancelled") return "cancelled";
  if (e.attendees && Array.isArray(e.attendees)) {
    const guests = e.attendees.filter((a: any) => !a.organizer);
    if (guests.length > 0) {
      if (guests.every((a: any) => a.responseStatus === "declined")) return "denied";
      if (guests.some((a: any) => a.responseStatus === "accepted")) return "confirmed";
      if (guests.some((a: any) => a.responseStatus === "tentative")) return "tentative";
      return "pending";
    }
  }
  return "confirmed";
}

export default class EventSvc {
  static async list(organizationId: string, userId: string, userEmail: string, filters: {
    startRange?: string;
    endRange?: string;
    excludeId?: string;
    excludeStatus?: string;
    limitOne?: boolean;
    caseId?: string;
  }) {
    return EventRepo.findMany(organizationId, userId, userEmail, filters);
  }

  static async getById(id: string, organizationId: string, userId: string, userEmail: string) {
    const event = await EventRepo.findById(id, organizationId, userId, userEmail);
    if (!event) throw new HttpError("Event not found", 404);
    return event;
  }

  static async create(organizationId: string, userId: string, body: {
    title?: string;
    type?: string;
    date_time?: string;
    dateTime?: string;
    client_email?: string;
    clientEmail?: string;
    notes?: string;
    status?: string;
    google_link?: string;
    google_event_id?: string;
    caseId?: string;
    case_id?: string;
    dateSource?: string;
    date_source?: string;
  }) {
    return EventRepo.create(organizationId, userId, {
      title: body.title || "Consultation",
      type: body.type || "Meeting",
      dateTime: new Date(body.date_time || body.dateTime || ""),
      clientEmail: body.client_email || body.clientEmail || undefined,
      notes: body.notes || undefined,
      status: body.status || "pending",
      googleLink: body.google_link || undefined,
      googleEventId: body.google_event_id || undefined,
      caseId: body.caseId || body.case_id || undefined,
      dateSource: body.dateSource || body.date_source || "calendar",
    });
  }

  static async updateById(id: string, organizationId: string, userId: string, userEmail: string, body: any) {
    const data: any = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.google_link !== undefined) data.googleLink = body.google_link;
    if (body.google_event_id !== undefined) data.googleEventId = body.google_event_id;
    if (body.title !== undefined) data.title = body.title;
    if (body.type !== undefined) data.type = body.type;
    if (body.date_time !== undefined) data.dateTime = new Date(body.date_time);
    if (body.client_email !== undefined) data.clientEmail = body.client_email;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.last_reminder_sent_at !== undefined) data.lastReminderSentAt = new Date(body.last_reminder_sent_at);
    if (body.reminder_day_before_sent_at !== undefined) data.reminderDayBeforeSentAt = new Date(body.reminder_day_before_sent_at);
    if (body.reminder_day_of_sent_at !== undefined) data.reminderDayOfSentAt = new Date(body.reminder_day_of_sent_at);
    if (body.lawyer_acknowledged_at !== undefined) data.lawyerAcknowledgedAt = new Date(body.lawyer_acknowledged_at);
    if (body.caseId !== undefined || body.case_id !== undefined) data.caseId = body.caseId || body.case_id || null;
    if (body.dateSource !== undefined || body.date_source !== undefined) data.dateSource = body.dateSource || body.date_source;

    const result = await EventRepo.updateById(id, organizationId, userId, userEmail, data);
    if (result.count === 0) throw new HttpError("Event not found", 404);
    return { success: true };
  }

  static async updateByGoogleEventId(googleEventId: string, organizationId: string, userId: string, userEmail: string, body: any) {
    const data: any = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.google_link !== undefined) data.googleLink = body.google_link;
    if (body.title !== undefined) data.title = body.title;
    if (body.type !== undefined) data.type = body.type;
    if (body.date_time !== undefined) data.dateTime = new Date(body.date_time);
    if (body.client_email !== undefined) data.clientEmail = body.client_email;
    if (body.notes !== undefined) data.notes = body.notes;

    const result = await EventRepo.updateByGoogleEventId(googleEventId, organizationId, userId, userEmail, data);
    return { success: true, count: result.count };
  }

  static async deleteById(id: string, organizationId: string, userId: string) {
    await EventRepo.deleteById(id, organizationId, userId);
  }

  static async deleteByGoogleEventId(googleEventId: string, organizationId: string, userId: string) {
    await EventRepo.deleteByGoogleEventId(googleEventId, organizationId, userId);
  }

  static async syncFromGoogleWebhook(organizationId: string, userId: string, googleEvents: any[]) {
    for (const ge of googleEvents) {
      if (ge.status === "cancelled") continue;

      const geTitle = ge.summary ?? "Untitled";
      const geTime = ge.start?.dateTime ?? ge.start?.date;
      if (!geTime) continue;

      const localMatch = await EventRepo.findFirstLocal(organizationId, userId, geTitle, new Date(geTime));

      if (localMatch) {
        await EventRepo.updateById(localMatch.id, organizationId, userId, "", {
          googleEventId: ge.id,
          googleLink: ge.htmlLink ?? localMatch.googleLink,
          status: getEventStatus(ge),
        });
      } else {
        await EventRepo.upsertByGoogleEventId(
          organizationId,
          userId,
          ge.id,
          {
            title: geTitle,
            type: inferEventType(geTitle, ge.description),
            dateTime: new Date(geTime),
            notes: ge.description?.replace(/\[type:[^\]]+\]\n?/, "").trim() || null,
            googleLink: ge.htmlLink ?? null,
            status: getEventStatus(ge),
          },
          {
            title: geTitle,
            type: inferEventType(geTitle, ge.description),
            status: getEventStatus(ge),
            googleLink: ge.htmlLink ?? null,
          }
        );
      }
    }

    const cancelledIds = googleEvents
      .filter((e: any) => e.status === "cancelled" && e.id)
      .map((e: any) => e.id);

    if (cancelledIds.length > 0) {
      await EventRepo.deleteManyByGoogleEventIds(organizationId, userId, cancelledIds);
    }
  }
}
