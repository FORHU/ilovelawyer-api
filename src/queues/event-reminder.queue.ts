import EventRepo from "../repositories/event.repository";
import NotificationSvc from "../services/notification.service";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { CLIENT_URL } from "../config";
import logger from "../utils/logger";

// Reminder lead times are set in whole days (1/2/3/5/7) via the UI, so a coarse poll interval
// is plenty precise while keeping the DB scan cheap.
const POLL_INTERVAL_MS = 5 * 60 * 1000;
// Widest UI-offered lead time is 1 week; the extra headroom still catches a longer lead time
// set directly via the API rather than through the calendar form.
const LOOKAHEAD_MS = 30 * 24 * 60 * 60 * 1000;

function formatEventDateTime(dateTime: Date): string {
  return dateTime.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
}

// Compact form for the subject line — the body already carries the full date/time.
function formatEventDateTimeShort(dateTime: Date): string {
  return dateTime.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

interface ReminderCandidate {
  id: string;
  userId: string;
  organizationId: string;
  title: string;
  type: string;
  dateTime: Date;
  notes: string | null;
  clientEmail: string | null;
  reminderLeadMinutes: number | null;
  user: { email: string };
  case: { caseName: string } | null;
}

/**
 * Polls for Events whose configured reminder lead time has arrived and emails the lawyer
 * (always) plus the client (if `clientEmail` was given) — the only reminder-sending process
 * in this codebase; nothing else reads `reminderLeadMinutes`/`lastReminderSentAt`.
 */
export default class EventReminderQueue {
  private static running = false;
  private static ticking = false;

  static start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("Event reminder queue started", { pollIntervalMs: POLL_INTERVAL_MS });
    void this.tick();
    setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  private static async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      const windowEnd = new Date(now.getTime() + LOOKAHEAD_MS);
      const candidates = await EventRepo.findDueForReminder(now, windowEnd);

      for (const event of candidates) {
        const leadMs = (event.reminderLeadMinutes ?? 0) * 60_000;
        const remindAt = new Date(event.dateTime.getTime() - leadMs);
        if (remindAt > now) continue;

        await this.sendReminder(event);
      }
    } catch (err) {
      logger.error("Event reminder queue: tick failed", { err });
    } finally {
      this.ticking = false;
    }
  }

  private static async sendReminder(event: ReminderCandidate): Promise<void> {
    const recipients = [...new Set([event.user.email, event.clientEmail].filter((e): e is string => !!e))];
    if (recipients.length === 0) {
      logger.warn("Event reminder queue: no recipient email, skipping", { eventId: event.id });
      return;
    }

    const eventType = (event.type || "event").toLowerCase();
    const when = formatEventDateTime(event.dateTime);
    const subject = `Reminder: ${event.title} — ${formatEventDateTimeShort(event.dateTime)}`;

    const html = await renderTemplate("event-reminder", {
      eventType,
      title: event.title,
      dateTime: when,
      caseName: event.case?.caseName ?? "",
      notes: event.notes ?? "",
      calendarLink: `${CLIENT_URL[0] ?? ""}/homepage/calendar`,
      // The dark lockup (light-colored logo) reads correctly against the header's dark band —
      // the plain "light" variant (dark-colored logo) would disappear against it.
      logoSrc: `${CLIENT_URL[0] ?? ""}/assets/logo/ilovelawyer-lockup-dark.png`,
    });
    const text = [
      `This is a reminder for your upcoming ${eventType}:`,
      "",
      event.title,
      when,
      event.case?.caseName ? `Case: ${event.case.caseName}` : null,
      event.notes ? `Notes: ${event.notes}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    const results = await Promise.allSettled(recipients.map((to) => sendEmail({ to, subject, text, html })));
    const sent = results.some((r) => r.status === "fulfilled");

    if (!sent) {
      logger.error("Event reminder queue: failed to send reminder to any recipient", { eventId: event.id });
      return;
    }

    await EventRepo.markReminderSent(event.id, new Date());

    // In-app bell notification for the lawyer only — the client recipient (if any) isn't
    // necessarily an app user and has no notification inbox to receive it in.
    await NotificationSvc.create({
      userId: event.userId,
      organizationId: event.organizationId,
      type: "EVENT_REMINDER",
      title: `Upcoming ${eventType}`,
      message: `${event.title} — ${when}`,
      link: "/homepage/calendar",
    }).catch((err) => logger.error("Event reminder queue: failed to create notification", { err, eventId: event.id }));
  }
}
