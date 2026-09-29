import fs from "node:fs";
import path from "node:path";
import { ENGINE_LIMITS_DIR } from "./paths.js";
import type { EngineLimitEngineSnapshot } from "./types.js";

/**
 * A bounded history of the account's live Claude readings (US4) —
 * the one thing the Auto-Dispatch page's usage graph needed that the tree did
 * not have: the Limits page and the engine-health refresh both read the
 * account and keep nothing.
 *
 * Recorded on the Claude collector's live path, which is the one place every
 * reading passes through — the loop's own tick calls the collector directly,
 * so a hook on `collectEngineLimits` would miss the readings that matter most.
 * Advisory, like the engine-health store: reads and writes swallow their own
 * errors, and a lost sample under a race between two writers (the gateway and
 * `jinn limits` on the same host; the preview, the Limits page and the loop
 * in-process) is accepted, which is why the write goes whole to a per-process
 * temporary name and is renamed — a fixed name would let two writers tear
 * each other, and then the file rather than a sample is what is lost.
 */

export interface UsageSampleWindow {
  name: string;
  usedPercent: number;
  /** Unix seconds — the window's identity, as the loop keys on it. */
  resetsAt: number;
}

export interface UsageSample {
  /** Epoch ms of the reading. */
  at: number;
  windows: UsageSampleWindow[];
}

/** A week, so a weekly projection reads the current week rather than two days of it. */
export const USAGE_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Readings this close to the last recorded one are the same reading: the
 *  dashboard's preview poll would otherwise record one a minute. */
export const USAGE_HISTORY_COLLAPSE_MS = 5 * 60_000;
/** A week at the collapse cadence is 2 016; this is the cap the cadence never reaches. */
export const USAGE_HISTORY_MAX_SAMPLES = 2_500;

export const USAGE_HISTORY_PATH = path.join(ENGINE_LIMITS_DIR, "claude-usage-history.json");

/** The reading as a sample, or undefined when it is not one to keep: not a
 *  live reading (the statusline fallback names its own write time, not the
 *  read's), or no five-hour or weekly window with a reset. A window without
 *  a reset instant — an untouched window reports none — is left out, exactly
 *  as the loop's own reading rule leaves it out of the verdict. */
export function sampleFromSnapshot(snapshot: EngineLimitEngineSnapshot, nowMs: number): UsageSample | undefined {
  if (snapshot.status !== "live") return undefined;
  const windows = (snapshot.windows ?? [])
    .filter((window) => window.name === "5h" || window.name === "7d" || window.name.startsWith("7d "))
    .filter((window) => window.usedPercent !== undefined && window.resetsAt !== undefined)
    .map((window) => ({ name: window.name, usedPercent: window.usedPercent as number, resetsAt: window.resetsAt as number }));
  return windows.length > 0 ? { at: nowMs, windows } : undefined;
}

/** The history with one more sample: collapsed onto the last one when it is
 *  within the collapse window, trimmed to the retention, and capped. Pure. */
export function appendSample(history: readonly UsageSample[], sample: UsageSample): UsageSample[] {
  const last = history[history.length - 1];
  const collapsed = last !== undefined && sample.at - last.at < USAGE_HISTORY_COLLAPSE_MS;
  const floor = sample.at - USAGE_HISTORY_RETENTION_MS;
  const kept = history.filter((entry) => entry.at >= floor && entry.at <= sample.at);
  return (collapsed ? kept : [...kept, sample]).slice(-USAGE_HISTORY_MAX_SAMPLES);
}

function isSample(value: unknown): value is UsageSample {
  const candidate = value as Partial<UsageSample> | null;
  return typeof candidate?.at === "number" && Array.isArray(candidate.windows);
}

/** Every retained sample since `sinceMs`, oldest first; an unreadable or
 *  malformed file is an empty history, never an error. */
export function readClaudeUsageHistory(sinceMs = 0, file: string = USAGE_HISTORY_PATH): UsageSample[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSample).filter((sample) => sample.at >= sinceMs);
  } catch {
    return [];
  }
}

function writeHistory(history: UsageSample[], file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(history));
  fs.renameSync(tmp, file);
}

/** Same samples at both ends and the same count: nothing to write. */
function sameHistory(a: readonly UsageSample[], b: readonly UsageSample[]): boolean {
  return a.length === b.length && a[0]?.at === b[0]?.at && a[a.length - 1]?.at === b[b.length - 1]?.at;
}

/** Record one reading. Never throws: the collector's job is the reading, and
 *  a history that cannot be written must not cost it. */
export function recordClaudeUsageSample(snapshot: EngineLimitEngineSnapshot, nowMs = Date.now(), file: string = USAGE_HISTORY_PATH): void {
  const sample = sampleFromSnapshot(snapshot, nowMs);
  if (!sample) return;
  try {
    const history = readClaudeUsageHistory(0, file);
    const next = appendSample(history, sample);
    if (!sameHistory(history, next)) writeHistory(next, file);
  } catch {
    // Advisory: a sample lost is the accepted cost; the reading still returns.
  }
}
