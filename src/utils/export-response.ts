import type { Response } from "express";
import DataExportSvc, { type ZipExportResult } from "../services/data-export.service";

/** Streams one user's data export to the client as a ZIP download. Returns the counts when the
 * whole archive was sent, or null when it failed part-way. By then the download has started and an
 * error page can't be sent, so the connection is cut: the client sees a failed download instead of
 * a truncated file that looks complete. */
export async function sendExportZip(res: Response, userId: string): Promise<ZipExportResult | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  res.status(200);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="ilovelawyer-my-data-${stamp}.zip"`);
  res.setHeader("Cache-Control", "no-store");

  try {
    // Waits for the client to catch up when its connection is slower than our database and storage.
    const sink = (chunk: Buffer) => (res.write(chunk) ? undefined : new Promise<void>((resolve) => res.once("drain", resolve)));
    const result = await DataExportSvc.streamZip(userId, sink);
    res.end();
    return result;
  } catch (err) {
    res.destroy(err as Error);
    return null;
  }
}

export function exportAuditPayload(result: ZipExportResult) {
  return {
    tables: Object.keys(result.counts).length,
    rows: Object.values(result.counts).reduce((a, b) => a + b, 0),
    files: result.filesIncluded,
    filesSkipped: result.filesSkipped,
  };
}
