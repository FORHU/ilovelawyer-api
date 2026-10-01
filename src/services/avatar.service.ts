import AuthRepo from "../repositories/auth.repository";
import FilesRepo from "../repositories/files.repository";
import FilesSvc from "./files.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { AVATAR_MAX_BYTES, GOOGLE_PHOTO_FETCH_TIMEOUT_MS, GOOGLE_PHOTO_SIZE_PX } from "../constants";

type ImageType = { mime: string; ext: string };

/** Identifies JPEG, PNG and WebP by their leading bytes. The declared Content-Type (multipart or
 * Google's response header) is never trusted on its own. */
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", ext: "png" };
  }
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/** Only Google's own photo CDN, over https — the URL comes from Google's userinfo, but the
 * server must never be pointed at an arbitrary host. The size suffix (`=s96-c`) is rewritten so
 * the stored copy isn't a blurry 96px thumbnail. Null when the URL isn't acceptable. */
export function googlePhotoUrl(picture: string): string | null {
  let url: URL;
  try {
    url = new URL(picture);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "googleusercontent.com" && !url.hostname.endsWith(".googleusercontent.com")) return null;
  url.pathname = url.pathname.replace(/=s\d+(-c)?$/, "") + `=s${GOOGLE_PHOTO_SIZE_PX}-c`;
  return url.toString();
}

export default class AvatarSvc {
  /** Copies a new Google user's profile photo into S3 as their avatar. Called once, only by the
   * request that created the account (never on a returning login or a link), and never awaited
   * by sign-in. Every failure is logged and leaves avatarId null, so the app shows initials. */
  static async importGooglePhoto(userId: string, picture: string | undefined): Promise<void> {
    if (!picture) return;
    const url = googlePhotoUrl(picture);
    if (!url) {
      logger.warn("Google photo import skipped: unexpected picture URL", { userId });
      return;
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_PHOTO_FETCH_TIMEOUT_MS), redirect: "error" });
      if (!res.ok) throw new Error(`Google photo fetch returned ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > AVATAR_MAX_BYTES) throw new Error("Google photo too large");
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > AVATAR_MAX_BYTES) throw new Error("Google photo too large");
      const type = detectImageType(buf);
      if (!type) throw new Error("Google photo is not a JPEG, PNG or WebP image");

      const file = await FilesSvc.upload(`google-photo.${type.ext}`, buf, type.mime);
      if (!(await AuthRepo.setAvatarIfEmpty(userId, file.id))) {
        // The user set their own avatar while this ran — theirs wins.
        await FilesRepo.markForDeletion(file.id);
      }
    } catch (err) {
      logger.error("Google photo import failed", { err, userId });
    }
  }

  /** Replaces the user's avatar with an uploaded image and soft-deletes the previous one. */
  static async setAvatar(userId: string, buf: Buffer) {
    if (buf.length === 0) throw new HttpError("No image uploaded", 400);
    if (buf.length > AVATAR_MAX_BYTES) throw new HttpError("Image must be 2 MB or smaller", 413);
    const type = detectImageType(buf);
    if (!type) throw new HttpError("Image must be a JPEG, PNG or WebP file", 400);

    const previous = await AuthRepo.findAvatarFile(userId);
    const file = await FilesSvc.upload(`avatar.${type.ext}`, buf, type.mime);
    const user = await AuthRepo.setAvatar(userId, file.id);
    if (previous) await FilesRepo.markForDeletion(previous.id);
    return user;
  }

  /** Back to initials. The Google photo is not restored. */
  static async removeAvatar(userId: string) {
    const previous = await AuthRepo.findAvatarFile(userId);
    const user = await AuthRepo.setAvatar(userId, null);
    if (previous) await FilesRepo.markForDeletion(previous.id);
    return user;
  }

  /** AccountDeletionQueue: flags the avatar File before the User row goes. Non-fatal. */
  static async releaseForDeletedUser(userId: string): Promise<void> {
    try {
      const avatar = await AuthRepo.findAvatarFile(userId);
      if (avatar) await FilesRepo.markForDeletion(avatar.id);
    } catch (err) {
      logger.error("Failed to release avatar for deleted user", { err, userId });
    }
  }
}
