import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IMAGE_CACHE_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

// Preview tiles are ~337 CSS px wide, so 720 covers them at DPR 2 while still
// cutting a phone photo by two orders of magnitude. WebP rather than JPEG
// because image attachments include PNGs with alpha, and flattening those onto
// a background colour is wrong in one of the two themes.
const THUMBNAIL_WIDTH = 720;
const THUMBNAIL_QUALITY = 72;

/** One thumbnail being made, with every request that is still waiting on it. */
interface InFlight {
  promise: Promise<string | null>;
  wants: Array<() => boolean>;
}

/** What a queued task resolves to when nobody waiting on it is left. */
const SKIPPED = Symbol("skipped");

const inFlight = new Map<string, InFlight>();
const failed = new Set<string>();
const pending: Array<() => void> = [];
let active = 0;

/**
 * Run `task` when a slot is free. `wanted` is asked again at that moment: a
 * task that sat in the queue while every client waiting on it left is not run.
 */
function runLimited<T>(task: () => Promise<T>, wanted: () => boolean): Promise<T | typeof SKIPPED> {
  return new Promise<T | typeof SKIPPED>((resolve, reject) => {
    const start = () => {
      if (!wanted()) {
        resolve(SKIPPED);
        pending.shift()?.();
        return;
      }
      active += 1;
      void task().then(resolve, reject).finally(() => {
        active -= 1;
        pending.shift()?.();
      });
    };
    if (active < 2) start();
    else pending.push(start);
  });
}

function thumbnailPath(key: string): string {
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(IMAGE_CACHE_DIR, digest, "thumb.webp");
}

async function generateThumbnail(source: string, destination: string): Promise<void> {
  const sharp = (await import("sharp")).default;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `${crypto.randomUUID()}.tmp.webp`);
  try {
    // .rotate() applies the EXIF orientation a phone camera records instead of
    // baking into the pixels; without it portrait photos come out sideways.
    await sharp(source)
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toFile(temporary);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.renameSync(temporary, destination);
}

/**
 * Vectors are already small, and rasterising untrusted SVG would pull a parser
 * into the request path for no byte saving, so they are served as uploaded.
 */
export function isThumbnailable(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

/**
 * Cached preview-sized copy of an image, or null when one cannot be produced —
 * callers serve the original in that case. A file that fails once is not tried
 * again for the life of the process.
 */
export async function ensureThumbnail(
  source: string,
  key: string,
  /** False once the caller no longer needs the result (its client left). */
  wanted: () => boolean = () => true,
): Promise<string | null> {
  const destination = thumbnailPath(key);
  if (fs.existsSync(destination)) return destination;
  if (failed.has(destination)) return null;
  const existing = inFlight.get(destination);
  if (existing) {
    existing.wants.push(wanted);
    return existing.promise;
  }
  const wants = [wanted];
  const entry: InFlight = { wants, promise: Promise.resolve(null) };
  const stillWanted = () => {
    if (wants.some((want) => want())) return true;
    // Drop the entry now, so a request arriving next starts its own task
    // instead of sharing one that is not going to run.
    if (inFlight.get(destination) === entry) inFlight.delete(destination);
    return false;
  };
  entry.promise = runLimited(() => generateThumbnail(source, destination), stillWanted)
    .then((ran) => (ran === SKIPPED ? null : destination))
    .catch((error: unknown) => {
      failed.add(destination);
      logger.warn(
        `Could not generate an image thumbnail; using the original image. ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    })
    .finally(() => {
      if (inFlight.get(destination) === entry) inFlight.delete(destination);
    });
  inFlight.set(destination, entry);
  return entry.promise;
}
