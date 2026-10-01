import EventRepo from "../repositories/event.repository";
import AuthRepo from "../repositories/auth.repository";
import GoogleCalendarSyncSvc, {
  EVENTS_URL,
  enqueue,
  googleFetch,
  notesFromDescription,
  ownerAccessToken,
  titleFromSummary,
  type EventRow,
} from "./google-calendar-sync.service";
import logger from "../utils/logger";
import { GOOGLE_CALENDAR_PULL_MAX_PAGES } from "../constants";

/** The parts of a Google event the pull reads. */
export interface GoogleItem {
  id: string;
  status?: string;
  updated?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  extendedProperties?: { private?: Record<string, string> };
}

interface ListResponse {
  items?: GoogleItem[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** What a Google event would change on its appointment — only the fields Google may edit
 * (title, start/end time, notes). Client and type are app-owned and never read back. An all-day
 * Google event has no time of day, so its times are left alone. */
export function changesFromGoogle(item: GoogleItem, event: EventRow): Record<string, unknown> {
  const changes: Record<string, unknown> = {};

  const title = titleFromSummary(item.summary);
  if (title && title !== event.title) changes.title = title;

  if (item.start?.dateTime) {
    const start = new Date(item.start.dateTime);
    if (start.getTime() !== event.dateTime.getTime()) changes.dateTime = start;
  }
  if (item.end?.dateTime) {
    const end = new Date(item.end.dateTime);
    if (end.getTime() !== event.endDateTime?.getTime()) changes.endDateTime = end;
  }

  const notes = notesFromDescription(item.description);
  if (notes !== (event.notes?.trim() || null)) changes.notes = notes;

  return changes;
}

/**
 * Google → app half of the two-way sync (GoogleCalendarSyncSvc is the other half). Polled per
 * connected user by GoogleCalendarSyncQueue (and nudged by the Calendar webhook, if a watch is
 * registered). Reads only what changed since last time (Google's syncToken) and only touches
 * appointments the app created: a Google event without the app's ilovelawyerEventId tag —
 * someone's dentist appointment — is never imported.
 *
 * Conflicts: the newer edit wins. A Google change older than an app edit that hasn't reached
 * Google yet (googleDirtyAt) is overwritten by pushing the app's version; a newer one is applied
 * here. The sync's own writes come back with the `updated` time already stored in
 * googleUpdatedAt and are skipped.
 */
export default class GoogleCalendarPullSvc {
  static async syncUser(userId: string): Promise<void> {
    const accessToken = await ownerAccessToken(userId);
    if (!accessToken) return;
    const stored = await AuthRepo.findGoogleCalendarTokens(userId);
    const syncToken = stored?.googleCalendarSyncToken ?? null;

    let pageToken: string | undefined;
    for (let page = 0; page < GOOGLE_CALENDAR_PULL_MAX_PAGES; page++) {
      // Same parameters every time: Google only honours a syncToken with the parameters it was
      // issued for. showDeleted so deletions come through on the first (baseline) pass too.
      const params = new URLSearchParams({ maxResults: "250", showDeleted: "true" });
      if (syncToken) params.set("syncToken", syncToken);
      if (pageToken) params.set("pageToken", pageToken);

      const res = await googleFetch(accessToken, `${EVENTS_URL}?${params}`);
      if (res.status === 410) {
        // Google expired the syncToken; the next poll takes a fresh baseline.
        logger.warn("Google Calendar syncToken expired; resetting", { userId });
        await AuthRepo.setGoogleCalendarSyncToken(userId, null);
        return;
      }
      if (!res.ok) throw new Error(`Google Calendar list failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);

      const data = (await res.json()) as ListResponse;
      for (const item of data.items ?? []) {
        await GoogleCalendarPullSvc.applyItem(userId, item);
      }

      if (data.nextSyncToken) {
        await AuthRepo.setGoogleCalendarSyncToken(userId, data.nextSyncToken);
        return;
      }
      if (!data.nextPageToken) return;
      pageToken = data.nextPageToken;
    }
    logger.warn("Google Calendar pull stopped at the page limit; continuing next poll", { userId });
  }

  /** Applies one changed Google event to its appointment, if it's one the app created. */
  static async applyItem(userId: string, item: GoogleItem): Promise<void> {
    // The app only creates single events; one instance of a recurring series isn't one of ours.
    if (item.recurringEventId) return;

    const appEventId = item.extendedProperties?.private?.ilovelawyerEventId;
    let event = appEventId ? await EventRepo.findRawById(appEventId) : null;
    if (event && event.userId !== userId) event = null;
    if (!event) event = await EventRepo.findByOwnerGoogleEventId(userId, item.id);
    // Not app-created, or an older copy the appointment has since moved on from.
    if (!event || event.googleEventId !== item.id) return;

    const eventId = event.id;
    await enqueue(eventId, async () => {
      // Re-read inside the queue: a push may have just changed it.
      const current = await EventRepo.findRawById(eventId);
      if (!current || current.googleEventId !== item.id) return;

      // Deleted in Google → cancelled in the app, never deleted (nothing lost by accident).
      // The Google copy is gone, so restoring it in the app creates a fresh one.
      if (item.status === "cancelled") {
        await EventRepo.applyGoogleChanges(current.id, {
          ...(current.status !== "cancelled" ? { status: "cancelled" } : {}),
          googleEventId: null,
          googleLink: null,
          googleUpdatedAt: null,
          googleDirtyAt: null,
        });
        return;
      }

      if (!item.updated) return;
      const googleUpdated = new Date(item.updated);
      // Already seen: the sync's own write coming back, or applied by an earlier poll.
      if (current.googleUpdatedAt && googleUpdated.getTime() <= current.googleUpdatedAt.getTime()) return;

      // The app has an edit Google hasn't got yet (its push failed or is still queued), made
      // after this Google change — the app's edit wins; put it on Google. Runs after this job.
      if (current.googleDirtyAt && current.googleDirtyAt.getTime() > googleUpdated.getTime()) {
        void GoogleCalendarSyncSvc.syncEvent(current.id);
        return;
      }

      // Google's change is the newer one; it wins (over an older pending app edit too).
      const changes = changesFromGoogle(item, current);
      // A new time means a new reminder, same as a reschedule in the app (EventSvc.updateById).
      if (changes.dateTime) changes.lastReminderSentAt = null;
      await EventRepo.applyGoogleChanges(current.id, { ...changes, googleUpdatedAt: googleUpdated, googleDirtyAt: null });
    });
  }
}
