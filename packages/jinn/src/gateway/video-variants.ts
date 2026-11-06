import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { VIDEO_CACHE_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

type VariantKind = "low" | "poster";
type ProcessResult = "ok" | "unavailable" | "failed";

/** One variant being made, with every request that is still waiting on it. */
interface InFlight {
  promise: Promise<string | null>;
  wants: Array<() => boolean>;
}

const inFlight = new Map<string, InFlight>();
const failed = new Set<string>();
const pending: Array<() => void> = [];
let active = 0;
let availability: Promise<boolean> | null = null;
let loggedUnavailable = false;

function runProcess(args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? "unavailable" : "failed"));
    child.once("exit", (code) => finish(code === 0 ? "ok" : "failed"));
  });
}

function logUnavailable(): void {
  if (loggedUnavailable) return;
  loggedUnavailable = true;
  logger.warn("Video previews will use original files because ffmpeg is unavailable.");
}

async function ffmpegAvailable(): Promise<boolean> {
  availability ??= runProcess(["-version"]).then((result) => {
    if (result !== "ok") logUnavailable();
    return result === "ok";
  });
  return availability;
}

/**
 * Run `task` when a slot is free. `wanted` is asked again at that moment: a
 * task that sat in the queue while every client waiting on it left is not run
 * and resolves to "skipped".
 */
function runLimited(task: () => Promise<ProcessResult>, wanted: () => boolean): Promise<ProcessResult | "skipped"> {
  return new Promise<ProcessResult | "skipped">((resolve, reject) => {
    const start = () => {
      if (!wanted()) {
        resolve("skipped");
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

function variantPath(key: string, kind: VariantKind): string {
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(VIDEO_CACHE_DIR, digest, kind === "low" ? "low.mp4" : "poster.jpg");
}

function ffmpegArgs(kind: VariantKind, source: string, destination: string): string[] {
  if (kind === "poster") {
    return [
      "-y", "-ss", "0.5", "-i", source, "-frames:v", "1",
      "-vf", "scale=-2:min(480\\,ih)", "-q:v", "4", destination,
    ];
  }
  return [
    "-y", "-i", source, "-vf", "scale=-2:min(480\\,ih)",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
    "-map_metadata", "-1", destination,
  ];
}

async function generateVariant(
  source: string,
  key: string,
  kind: VariantKind,
  wanted: () => boolean,
): Promise<string | null> {
  const destination = variantPath(key, kind);
  if (fs.existsSync(destination)) return destination;
  if (failed.has(destination)) return null;
  if (!(await ffmpegAvailable())) return null;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const extension = kind === "low" ? ".mp4" : ".jpg";
  const temporary = path.join(path.dirname(destination), `${crypto.randomUUID()}.tmp${extension}`);
  const result = await runLimited(() => runProcess(ffmpegArgs(kind, source, temporary)), wanted);
  if (result === "skipped") {
    // Nobody is waiting any more; not a failure, so a later request may try.
    fs.rmSync(temporary, { force: true });
    return null;
  }
  if (result === "ok" && fs.existsSync(temporary)) {
    fs.renameSync(temporary, destination);
    return destination;
  }
  fs.rmSync(temporary, { force: true });
  failed.add(destination);
  if (result === "unavailable") logUnavailable();
  else logger.warn(`Could not generate ${kind === "low" ? "a data-saver video" : "a video poster"}; using the original video.`);
  return null;
}

function requestVariant(
  source: string,
  key: string,
  kind: VariantKind,
  wanted: () => boolean,
): Promise<string | null> {
  const destination = variantPath(key, kind);
  if (fs.existsSync(destination)) return Promise.resolve(destination);
  if (failed.has(destination)) return Promise.resolve(null);
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
  entry.promise = generateVariant(source, key, kind, stillWanted)
    .catch((error) => {
      failed.add(destination);
      logger.warn(`Could not generate a video ${kind}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    })
    .finally(() => {
      if (inFlight.get(destination) === entry) inFlight.delete(destination);
    });
  inFlight.set(destination, entry);
  return entry.promise;
}

export function ensureLowVariant(source: string, key: string): string | null {
  const destination = variantPath(key, "low");
  if (fs.existsSync(destination)) return destination;
  // Background warm-up for a later request: no client waits on this one, so it is always wanted.
  if (!failed.has(destination)) void requestVariant(source, key, "low", () => true);
  return null;
}

export async function ensurePoster(
  source: string,
  key: string,
  /** False once the caller no longer needs the result (its client left). */
  wanted: () => boolean = () => true,
): Promise<string | null> {
  return requestVariant(source, key, "poster", wanted);
}
