/**
 * agy keeps its own print-mode diagnostics in a rotating log under its home.
 * When a headless turn ends without a terminal result, that log is usually the
 * only place the real reason is written, so we quote it back to the operator
 * instead of reporting a bare exit code.
 */
import fs from "node:fs";
import path from "node:path";
import { ANTIGRAVITY_HOME } from "./antigravity-protocol.js";

export const ANTIGRAVITY_LOG_DIR = path.join(ANTIGRAVITY_HOME, "log");

/** These logs cover a whole CLI run, so only the trailing chunk is read. */
const LOG_TAIL_BYTES = 8 * 1024;

/** glog error line: `E0824 01:30:11.830534  1 printmode.go:521] Print mode: timed out after 50 polls`. */
const PRINT_MODE_ERROR = /\bE\d{4} [\d:.]+\s+\d+ printmode\.go:\d+\] (.+)/g;

function readTail(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function newestLogWrittenSince(logDir: string, sinceMs: number): string | undefined {
  return fs.readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(logDir, entry.name))
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .filter((log) => log.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath;
}

/**
 * agy's own explanation for a turn that produced no terminal result, or
 * undefined when the log is missing, unreadable, older than the turn, or
 * carries no error — in which case the caller keeps its existing wording.
 */
export function readAntigravityPrintModeError(
  turnStartedAtMs: number,
  logDir = ANTIGRAVITY_LOG_DIR,
): string | undefined {
  try {
    const filePath = newestLogWrittenSince(logDir, turnStartedAtMs);
    if (!filePath) return undefined;
    return [...readTail(filePath).matchAll(PRINT_MODE_ERROR)].at(-1)?.[1]?.trim();
  } catch {
    return undefined;
  }
}
