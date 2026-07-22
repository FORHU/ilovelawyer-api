import prisma from "../lib/prisma";
import CalendarWatchChannelRepo from "../repositories/calendar-watch-channel.repository";
import { refreshGoogleAccessToken } from "../utils/googleRefreshToken";
import HttpError from "../utils/http-error";

export default class CalendarWatchChannelSvc {
  static async registerWatch(userId: string, webhookUrl: string, googleAccessToken?: string | null, googleRefreshToken?: string | null) {
    if (!webhookUrl) throw new HttpError("Missing webhookUrl", 400);

    if (!googleAccessToken) throw new HttpError("Missing Google access token", 400);

    if (webhookUrl.includes("localhost") || webhookUrl.includes("127.0.0.1")) {
      return { success: true, message: "Skipping Google Watch API on localhost (HTTPS required for webhooks)." };
    }

    const channelId = crypto.randomUUID();
    const watchUrl = "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch";

    const makeWatchRequest = (token: string) =>
      fetch(watchUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: channelId, type: "web_hook", address: webhookUrl }),
      });

    let response = await makeWatchRequest(googleAccessToken);

    if (response.status === 401 && googleRefreshToken) {
      const refreshed = await refreshGoogleAccessToken(googleRefreshToken);
      if (refreshed) {
        await prisma.user.update({ where: { id: userId }, data: { googleAccessToken: refreshed } });
        response = await makeWatchRequest(refreshed);
      }
    }

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
