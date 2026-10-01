import EventRepo from "../repositories/event.repository";
import AuthRepo from "../repositories/auth.repository";
import GoogleCalendarSvc from "./google-calendar.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { GOOGLE_CALENDAR_DEFAULT_EVENT_MINUTES } from "../constants";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type EventRow = NonNullable<Awaited<ReturnType<typeof EventRepo.findRawById>>>;

/** Appointment fields that appear on the Google copy — an update touching none of them (a
 * reminder timestamp, an acknowledgement) doesn't need a sync. */
export const GOOGLE_SYNCED_EVENT_FIELDS = ["status", "title", "type", "dateTime", "endDateTime", "clientEmail", "notes"] as const;

/** The Google event body for an appointment. The `[type:…]` tag is what EventSvc's webhook
 * import (inferEventType) reads back. The client is listed in the description, not as an
 * attendee: an attendee would make Google email them an invitation. */
export function toGoogleEvent(event: EventRow) {
  const start = event.dateTime;
  const end = event.endDateTime ?? new Date(start.getTime() + GOOGLE_CALENDAR_DEFAULT_EVENT_MINUTES * 60_000);
  const description = [
    `[type:${event.type.toLowerCase()}]`,
    event.notes?.trim(),
    event.clientEmail ? `Client: ${event.clientEmail}` : null,
    "Scheduled in ilovelawyer",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    summary: event.title,
    description,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: { private: { ilovelawyerEventId: event.id } },
  };
}

// Per-appointment queue: a create followed quickly by an edit must not both see "no Google
// copy yet" and insert two Google events. Single API process; good enough until two-way sync.
const pending = new Map<string, Promise<void>>();

function enqueue(eventId: string, job: () => Promise<void>): Promise<void> {
  const run = (pending.get(eventId) ?? Promise.resolve()).then(job).catch((err) => {
    logger.error("Google Calendar sync failed", { err, eventId });
  });
  pending.set(eventId, run);
  void run.finally(() => {
    if (pending.get(eventId) === run) pending.delete(eventId);
  });
  return run;
}

/** Null when the owner hasn't connected Google Calendar (nothing to do). A revoked grant is
 * cleared by GoogleCalendarSvc and also ends up here as "not connected". */
async function ownerAccessToken(userId: string): Promise<string | null> {
  const tokens = await AuthRepo.findGoogleCalendarTokens(userId);
  if (!tokens?.googleRefreshToken) return null;
  try {
    return await GoogleCalendarSvc.getAccessToken(userId);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 409) {
      logger.warn("Google Calendar sync skipped: owner needs to reconnect Google Calendar", { userId });
      return null;
    }
    throw err;
  }
}

async function googleFetch(accessToken: string, url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
  });
}

/** 404/410: the Google copy is already gone (deleted in Google, or by an earlier sync). */
const isGone = (res: Response) => res.status === 404 || res.status === 410;

async function failure(res: Response, action: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`Google Calendar ${action} failed: ${res.status} ${body.slice(0, 300)}`);
}

/**
 * One-way sync, app → Google: keeps a copy of each appointment on its owner's primary Google
 * Calendar once they've connected Google Calendar (GoogleCalendarSvc). Fire-and-forget from
 * EventSvc — never blocks or fails the appointment change itself; errors are logged. Google →
 * app (the watch/webhook) is separate and not switched on.
 */
export default class GoogleCalendarSyncSvc {
  /** Creates, updates or removes the Google copy to match the appointment as it is now. */
  static syncEvent(eventId: string): Promise<void> {
    return enqueue(eventId, async () => {
      const event = await EventRepo.findRawById(eventId);
      if (!event) return;
      const accessToken = await ownerAccessToken(event.userId);
      if (!accessToken) return;

      // Cancelled → remove the Google copy; restoring the appointment creates a fresh one.
      if (event.status === "cancelled") {
        if (!event.googleEventId) return;
        const res = await googleFetch(accessToken, `${EVENTS_URL}/${encodeURIComponent(event.googleEventId)}`, { method: "DELETE" });
        if (!res.ok && !isGone(res)) throw await failure(res, "delete");
        await EventRepo.setGoogleRef(event.id, null, null);
        return;
      }

      const body = JSON.stringify(toGoogleEvent(event));
      if (event.googleEventId) {
        const res = await googleFetch(accessToken, `${EVENTS_URL}/${encodeURIComponent(event.googleEventId)}`, { method: "PATCH", body });
        if (res.ok) return;
        if (!isGone(res)) throw await failure(res, "update");
        // Deleted in Google meanwhile — fall through and create it again.
      }

      const res = await googleFetch(accessToken, EVENTS_URL, { method: "POST", body });
      if (!res.ok) throw await failure(res, "create");
      const created = (await res.json()) as { id?: string; htmlLink?: string };
      if (created.id) await EventRepo.setGoogleRef(event.id, created.id, created.htmlLink ?? null);
    });
  }

  /** After an appointment is deleted: removes its Google copy. Takes the row as it was before
   * the delete, since it can't be re-read. */
  static removeDeletedEvent(event: { id: string; userId: string; googleEventId: string | null }): Promise<void> {
    return enqueue(event.id, async () => {
      if (!event.googleEventId) return;
      const accessToken = await ownerAccessToken(event.userId);
      if (!accessToken) return;
      const res = await googleFetch(accessToken, `${EVENTS_URL}/${encodeURIComponent(event.googleEventId)}`, { method: "DELETE" });
      if (!res.ok && !isGone(res)) throw await failure(res, "delete");
    });
  }
}
