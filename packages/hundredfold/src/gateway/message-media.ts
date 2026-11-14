// Turning a stored file into the attachment descriptor the web UI renders.
// Split out of `files.ts`, which owns the upload, storage and download routes.
import { getFile, type FileMeta } from "../sessions/file-registry.js";
import type { MessageMedia } from "../sessions/registry.js";

function mediaTypeFromMime(mime: string | null): MessageMedia["type"] {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime?.startsWith("video/")) return "video";
  return "file";
}

export function buildMessageMedia(meta: FileMeta): MessageMedia {
  return {
    type: mediaTypeFromMime(meta.mimetype),
    url: `/api/files/${meta.id}`,
    name: meta.filename,
    mimeType: meta.mimetype ?? undefined,
    size: meta.size,
    // Carried only when the row has both: the client reserves a box from the pair
    // and treats a missing one as "measure it on decode".
    ...(meta.width !== undefined && meta.height !== undefined ? { width: meta.width, height: meta.height } : {}),
  };
}

/** Resolve uploaded file IDs to media descriptors for persisting on a (user) message. */
export function fileIdsToMedia(fileIds: unknown): MessageMedia[] {
  if (!Array.isArray(fileIds)) return [];
  const media: MessageMedia[] = [];
  for (const id of fileIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const meta = getFile(id);
    if (meta) media.push(buildMessageMedia(meta));
  }
  return media;
}
