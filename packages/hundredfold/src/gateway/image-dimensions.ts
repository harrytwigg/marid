import { logger } from "../shared/logger.js";

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * The pixel size a browser will lay an uploaded image out at, or null when it
 * cannot be read.
 *
 * `autoOrient` rather than the top-level width/height, because `metadata()`
 * reports the stored pixels: a phone photo carrying EXIF orientation 6 is stored
 * landscape and displayed portrait, and recording the stored shape would reserve
 * a landscape box around a portrait picture — the layout shift this exists to
 * prevent, wearing a hat. The thumbnail path has the same rule as `.rotate()`.
 *
 * This reads the container header instead of decoding the pixels, so it is cheap
 * enough to sit on the upload request tick. Null on any failure: an attachment
 * with no dimensions renders on the client's fallback, but a probe that threw
 * must never cost the caller their upload.
 */
export async function readImageDimensions(buffer: Buffer): Promise<ImageDimensions | null> {
  try {
    const sharp = (await import("sharp")).default;
    const { width, height } = (await sharp(buffer).metadata()).autoOrient;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
    return { width, height };
  } catch (error) {
    logger.warn(
      `Could not read image dimensions; the attachment is stored without them. ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
