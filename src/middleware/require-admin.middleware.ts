import { Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";

// Runs after validSession (needs req.user.userId). Looks the role up fresh from the
// DB rather than trusting a claim on the (long-lived) access token, so revoking admin
// access takes effect immediately instead of waiting for the token to expire.
export default async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { role: true },
  });

  if (!user || user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required" });
  }

  next();
}
