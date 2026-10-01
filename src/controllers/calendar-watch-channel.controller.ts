import { Request, Response } from "express";
import CalendarWatchChannelSvc from "../services/calendar-watch-channel.service";
import GoogleCalendarPullSvc from "../services/google-calendar-pull.service";
import { calendarChannelToken } from "../utils/google-token-crypto";
import logger from "../utils/logger";

export default class CalendarWatchChannelCtrl {
  static async registerWatch(req: Request, res: Response) {
    const { webhookUrl } = req.body;
    const result = await CalendarWatchChannelSvc.registerWatch(req.user.userId, webhookUrl);

    return res.status(200).json(result);
  }

  /** Google push notification for a registered watch: only a nudge to pull now rather than at
   * the next poll — GoogleCalendarPullSvc does the work, and only for app-created events. Always
   * 200 to Google; anything not carrying the channel's secret token is ignored. */
  static async handleWebhook(req: Request, res: Response) {
    const channelId = req.headers["x-goog-channel-id"] as string;
    const channelToken = req.headers["x-goog-channel-token"] as string;
    const resourceState = req.headers["x-goog-resource-state"] as string;

    if (!channelId) return res.status(200).send("Ignored");
    const expected = calendarChannelToken(channelId);
    if (!expected || channelToken !== expected) return res.status(200).send("Ignored");
    if (resourceState !== "exists") return res.status(200).send("Ignored");

    const channel = await CalendarWatchChannelSvc.findByChannelId(channelId);
    if (!channel) return res.status(200).send("Unknown channel");

    // Answer Google straight away; the pull runs in the background.
    void GoogleCalendarPullSvc.syncUser(channel.userId).catch((err) =>
      logger.error("Calendar webhook: pull failed", { err, userId: channel.userId }),
    );
    return res.status(200).send("Queued");
  }
}
