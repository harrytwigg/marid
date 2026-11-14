import fs from "node:fs";
import path from "node:path";

/**
 * Image attachments as MSP input parts.
 *
 * A turn's `input` takes `{type:"image", base64Data, mediaType}` parts, so a
 * picture reaches the model as a picture. Every other attachment (and any image
 * that cannot be read or is too large for one request) stays what opencode makes
 * of it: a path named in the prompt text for the model to open itself.
 */

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** An image bigger than this goes as a path: the base64 of it travels in a single line of the host's stdin. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface MuseImagePart {
  type: "image";
  base64Data: string;
  mediaType: string;
}

export interface MuseAttachments {
  images: MuseImagePart[];
  /** The attachments that did not go as images, still to be named in the prompt. */
  remaining: string[];
}

export function loadMuseAttachments(attachments: readonly string[] | undefined): MuseAttachments {
  const images: MuseImagePart[] = [];
  const remaining: string[] = [];
  for (const file of attachments ?? []) {
    const mediaType = IMAGE_MEDIA_TYPES[path.extname(file).toLowerCase()];
    const data = mediaType ? readImage(file) : undefined;
    if (mediaType && data) images.push({ type: "image", base64Data: data, mediaType });
    else remaining.push(file);
  }
  return { images, remaining };
}

function readImage(file: string): string | undefined {
  try {
    const size = fs.statSync(file).size;
    if (size === 0 || size > MAX_IMAGE_BYTES) return undefined;
    return fs.readFileSync(file).toString("base64");
  } catch {
    return undefined;
  }
}
