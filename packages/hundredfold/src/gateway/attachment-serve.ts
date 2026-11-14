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
function storedFileProblem(attachment: WorkItemAttachment): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(attachment.storagePath);
  } catch {
    logger.error(`Attachment ${attachment.id} content missing on disk: ${attachment.storagePath}`);
    return "attachment content is missing from storage";
  }
  if (stat.isFile() && stat.size === attachment.bytes) return undefined;
  logger.error(
    `Attachment ${attachment.id} failed size verification: stored ${attachment.storagePath} is ${stat.size} bytes, row says ${attachment.bytes}`,
  );
  return "attachment content failed size verification — the stored file does not match its recorded size";
}

export async function serveAttachmentBytes(
  req: IncomingMessage,
  res: ServerResponse,
  attachment: WorkItemAttachment,
  pathname: string,
): Promise<void> {
  const problem = storedFileProblem(attachment);
  if (problem) return serverError(res, problem);
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
    cacheHeaders: cacheHeadersFor(selected.isFallback, etag),
  });
}

/** A resolved variant is immutable and cached for good; a fallback stands in for one that could not be made, and is not. */
function cacheHeadersFor(isFallback: boolean, etag: string): Record<string, string> {
  return isFallback ? { "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=31536000, immutable", ETag: etag };
}
