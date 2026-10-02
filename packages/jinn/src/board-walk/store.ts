import fs from "node:fs";
import path from "node:path";
import { JINN_HOME, LOGS_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

/**
 * The board walk's two files.
 *
 *   - `state/board-walk.json` — what one tick leaves for the next: the last
 *     five-hour reading (the usage-delta operator signal compares against it)
 *     and which Todos have already been flagged stuck, so a stuck Todo is raised
 *     once rather than every tick.
 *   - `logs/board-walk.jsonl` — the tick log. One line per tick, every decision
 *     in it with its reason, including "nothing to do". Bounded: trimmed to the
 *     newest lines when it grows past a size.
 */

export const BOARD_WALK_STATE_FILE = path.join(JINN_HOME, "state", "board-walk.json");
export const BOARD_WALK_LOG_FILE = path.join(LOGS_DIR, "board-walk.jsonl");
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_LINES = 2000;

export interface PriorFiveHour {
  resetsAt: number;
  usedPercent: number;
  atMs: number;
}

export interface BoardWalkState {
  priorFiveHour?: PriorFiveHour;
  /** Todo id → the stuck episode already flagged (see `stuckEpisode`). */
  stuckFlags: Record<string, string>;
}

export function readState(file = BOARD_WALK_STATE_FILE): BoardWalkState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<BoardWalkState>;
    return {
      ...(parsed.priorFiveHour ? { priorFiveHour: parsed.priorFiveHour } : {}),
      stuckFlags: parsed.stuckFlags && typeof parsed.stuckFlags === "object" ? parsed.stuckFlags : {},
    };
  } catch {
    return { stuckFlags: {} };
  }
}

export function writeState(state: BoardWalkState, file = BOARD_WALK_STATE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

// ── Tick log ─────────────────────────────────────────────────────────────────

export type TickEntryKind =
  | "release" | "park" | "stuck" | "dispatch" | "gated" | "ready" | "unclear"
  | "hold" | "nothing" | "refused" | "error";

export interface TickEntry {
  kind: TickEntryKind;
  workItemId?: string;
  reason: string;
  /** What the gateway did with the decision: done, refused (and why), or skipped. */
  outcome?: string;
  sessionId?: string;
}

/** `disabled` is only in older log lines: the walk was switched off in
 *  board-walk.md then. A disabled cron job now simply does not fire. */
export type TickOutcome = "ok" | "disabled" | "invalid-rules" | "failed" | "busy";

export interface TickRecord {
  at: string;
  trigger: "schedule" | "manual";
  outcome: TickOutcome;
  /** One sentence: what the tick came to, by the gateway's count. */
  summary: string;
  /** The model's own summary of its answer. What it says it decided, which
   *  the gateway may have refused: the entries say what happened. */
  modelSummary?: string;
  sessionId?: string;
  durationMs?: number;
  entries: TickEntry[];
}

function trimLog(file: string): void {
  try {
    if (fs.statSync(file).size <= LOG_MAX_BYTES) return;
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, lines.slice(-LOG_KEEP_LINES).join("\n") + "\n", "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    // best effort: an untrimmed log is still a log
  }
}

export function appendTick(record: TickRecord, file = BOARD_WALK_LOG_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
    trimLog(file);
  } catch (error) {
    logger.warn(`Board walk: could not write the tick log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Newest first. */
export function readTicks(limit = 50, file = BOARD_WALK_LOG_FILE): TickRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const records: TickRecord[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
    if (!lines[i].trim()) continue;
    try {
      records.push(JSON.parse(lines[i]) as TickRecord);
    } catch {
      // a torn line is skipped, not fatal
    }
  }
  return records;
}
