import CalendarWatchChannelRepo from "../repositories/calendar-watch-channel.repository";
import GoogleCalendarSvc from "./google-calendar.service";
import HttpError from "../utils/http-error";

export default class CalendarWatchChannelSvc {
  /** Needs a connected Google Calendar (GoogleCalendarSvc) — the access token is minted from the
   * stored refresh token, never taken from the request. */
  static async registerWatch(userId: string, webhookUrl: string) {
    if (!webhookUrl) throw new HttpError("Missing webhookUrl", 400);

    if (webhookUrl.includes("localhost") || webhookUrl.includes("127.0.0.1")) {
      return { success: true, message: "Skipping Google Watch API on localhost (HTTPS required for webhooks)." };
    }

    const accessToken = await GoogleCalendarSvc.getAccessToken(userId);
    const channelId = crypto.randomUUID();

    const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events/watch", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: channelId, type: "web_hook", address: webhookUrl }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new HttpError(`Failed to create watch channel: ${JSON.stringify(errorData)}`, response.status);
    }

    const watchData = await response.json();

    await CalendarWatchChannelRepo.replaceForUser(userId, {
      channelId,
      resourceId: watchData.resourceId ?? "",
      expiration: watchData.expiration ? BigInt(watchData.expiration) : BigInt(0),
    });

    return { success: true, message: "Successfully registered calendar webhook watch.", watchData, channelId };
  }

  static async findByChannelId(channelId: string) {
    return CalendarWatchChannelRepo.findByChannelId(channelId);
  }
}
