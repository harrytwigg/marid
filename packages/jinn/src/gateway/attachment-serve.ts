import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../shared/logger.js";
import type { WorkItemAttachment } from "../work-items/attachments.js";
import { selectAttachmentVariant } from "./attachment-variants.js";
import { streamFile } from "./byte-range.js";
import { isFileNotModified } from "./files.js";
import { clientGone, notFound, serverError } from "./route-helpers.js";

/**
 * Stream or download a stored attachment. Uploads are hash-verified into content-addressed storage; reads
 * keep the cheap size guard so byte ranges never require loading and hashing the whole blob. One
 * implementation for every route that serves attachment bytes (the operator's and a board member's).
 */
export async function serveAttachmentBytes(
  req: IncomingMessage,
  res: ServerResponse,
  attachment: WorkItemAttachment,
  pathname: string,
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(attachment.storagePath);
  } catch {
    logger.error(`Attachment ${attachment.id} content missing on disk: ${attachment.storagePath}`);
    return serverError(res, "attachment content is missing from storage");
  }
  if (!stat.isFile() || stat.size !== attachment.bytes) {
    logger.error(
      `Attachment ${attachment.id} failed size verification: stored ${attachment.storagePath} is ${stat.size} bytes, row says ${attachment.bytes}`,
    );
    return serverError(res, "attachment content failed size verification — the stored file does not match its recorded size");
  }
  const reqUrl = new URL(req.url || pathname, `http://${req.headers.host || "localhost"}`);
  const download = reqUrl.searchParams.get("download") === "1";
  // A reader who already left (a thumbnail it scrolled past) gets no
  // sharp/ffmpeg work done on its behalf.
  if (clientGone(res)) return;
  const selected = await selectAttachmentVariant(attachment, reqUrl.searchParams, download, () => !clientGone(res));
  if (!selected) return notFound(res);
  const etag = `"${attachment.sha256}-${selected.variant}-${selected.size}"`;
  if (!selected.isFallback && isFileNotModified(req.headers, etag, Number.NaN)) {
    res.writeHead(304, { "Cache-Control": "public, max-age=31536000, immutable", ETag: etag }).end();
    return;
  }
  await streamFile(req, res, selected.path, {
    mime: selected.mime,
    filename: selected.filename,
    disposition: download || !attachment.mime.startsWith("video/") ? "attachment" : "inline",
    cacheHeaders: selected.isFallback
      ? { "Cache-Control": "no-store" }
      : { "Cache-Control": "public, max-age=31536000, immutable", ETag: etag },
  });
}
