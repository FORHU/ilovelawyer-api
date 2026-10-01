import AuthRepo from "../repositories/auth.repository";
import GoogleCalendarPullSvc from "../services/google-calendar-pull.service";
import { redis } from "../lib/redis";
import logger from "../utils/logger";
import { GOOGLE_CALENDAR_POLL_INTERVAL_MS } from "../constants";

/**
 * Polls every Google Calendar-connected user for changes made in Google (GoogleCalendarPullSvc)
 * — the Google → app half of the two-way sync. Polling rather than Google's push channels: no
 * public webhook to secure, no weekly channel renewal, and it works on a local machine. A change
 * made in Google reaches the app within about GOOGLE_CALENDAR_POLL_INTERVAL_MS.
 */
export default class GoogleCalendarSyncQueue {
  private static running = false;
  private static ticking = false;

  static start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    setInterval(() => void this.tick(), GOOGLE_CALENDAR_POLL_INTERVAL_MS);
  }

  private static async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const userIds = await AuthRepo.findGoogleCalendarUserIds();
      for (const userId of userIds) {
        // One API instance per user per interval. Redis unreachable (null) → go ahead: a
        // duplicate pull is harmless (its writes are idempotent), just wasted work.
        const claimed = await redis.setIfAbsent(`google-calendar-sync:${userId}`, 1, Math.floor(GOOGLE_CALENDAR_POLL_INTERVAL_MS / 1000) - 10);
        if (claimed === false) continue;
        try {
          await GoogleCalendarPullSvc.syncUser(userId);
        } catch (err) {
          logger.error("Google Calendar sync queue: pull failed", { err, userId });
        }
      }
    } catch (err) {
      logger.error("Google Calendar sync queue: tick failed", { err });
    } finally {
      this.ticking = false;
    }
  }
}
