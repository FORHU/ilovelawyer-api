import { Request, Response } from "express";
import CalendarWatchChannelSvc from "../services/calendar-watch-channel.service";
import EventSvc from "../services/event.service";
import { refreshGoogleAccessToken } from "../utils/googleRefreshToken";
import prisma from "../lib/prisma";
import OrganizationMemberRepo from "../repositories/organization-member.repository";

export default class CalendarWatchChannelCtrl {
  static async registerWatch(req: Request, res: Response) {
    const { webhookUrl, providerToken } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { googleAccessToken: true, googleRefreshToken: true },
    });

    const googleAccessToken = user?.googleAccessToken || providerToken;
    const result = await CalendarWatchChannelSvc.registerWatch(
      req.user.userId,
      webhookUrl,
      googleAccessToken,
      user?.googleRefreshToken,
    );

    return res.status(200).json(result);
  }

  static async handleWebhook(req: Request, res: Response) {
    const channelId = req.headers["x-goog-channel-id"] as string;
    const resourceState = req.headers["x-goog-resource-state"] as string;

    if (resourceState === "sync") return res.status(200).send("Sync acknowledged");
    if (resourceState !== "exists" || !channelId) return res.status(200).send("Ignored");

    const channel = await CalendarWatchChannelSvc.findByChannelId(channelId);
    if (!channel) return res.status(200).send("Unknown channel");

    const user = await prisma.user.findUnique({
      where: { id: channel.userId },
      select: { googleRefreshToken: true },
    });

    if (!user?.googleRefreshToken) return res.status(200).send("No refresh token");

    const accessToken = await refreshGoogleAccessToken(user.googleRefreshToken);
    if (!accessToken) return res.status(200).send("Token refresh failed");

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("timeMin", monthStart.toISOString());
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("fields", "items(id,summary,description,start,htmlLink,attendees(email,responseStatus,organizer),status,iCalUID)");

    const googleRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!googleRes.ok) return res.status(200).send("Google fetch failed");

    const googleData = await googleRes.json();
    const googleEvents: any[] = googleData.items ?? [];

    if (googleEvents.length === 0) return res.status(200).send("No events to sync");

    // No X-Organization-Id header on a Google-originated webhook — resolve the
    // channel owner's (guaranteed-singular) org membership directly.
    const membership = await OrganizationMemberRepo.findAnyForUser(channel.userId);
    if (!membership) return res.status(200).send("User has no organization");

    await EventSvc.syncFromGoogleWebhook(membership.organizationId, channel.userId, googleEvents);

    return res.status(200).send("Synced");
  }
}
