/**
 * Locating a Codex thread's rollout, and making it visible to a second session.
 *
 * Codex resumes a thread by reading its rollout JSONL out of `CODEX_HOME`, and
 * Hundredfold points every session at a home of its own. So handing a new session a
 * thread id is not enough — without the rollout beside it, `codex exec resume`
 * finds nothing and quietly opens a fresh thread instead, which looks like a
 * resume and is not one.
 */

import fs from "node:fs";
import path from "node:path";
import { codexSessionHomeDir, realCodexHome } from "./codex.js";

function sessionsRoot(home: string): string {
  return path.join(home, "sessions");
}

/** Where a session's threads may live: its own home first, then the real one it
 *  falls back to when no per-session overlay is in play. */
function rolloutRoots(sessionId: string, baseDir?: string): string[] {
  return [sessionsRoot(codexSessionHomeDir(sessionId, baseDir)), sessionsRoot(realCodexHome(baseDir))];
}

/** The rollout carrying `threadId` under a sessions root, or null. Codex files
 *  it as `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; unreadable directories are
 *  skipped rather than raised, since a missing rollout is an ordinary outcome. */
export function findCodexSessionFile(root: string, threadId: string): string | null {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      else if (entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) return path.join(dir, entry.name);
    }
  }
  return null;
}

/** The rollout for `threadId` as the given Hundredfold session can see it, or null. */
export function findCodexRollout(sessionId: string, threadId: string, baseDir?: string): string | null {
  for (const root of rolloutRoots(sessionId, baseDir)) {
    const found = findCodexSessionFile(root, threadId);
    if (found) return found;
  }
  return null;
}

/**
 * Copy a thread's rollout into another session's home, keeping the thread id so
 * the target resumes the same conversation. A copy rather than a shared file:
 * both homes stay independently writable, so the two sessions cannot race.
 * Returns false when the source rollout is gone — the retention sweep reaches
 * homes that have sat idle — which the caller treats as "dispatch cold".
 */
export function copyCodexRollout(input: {
  threadId: string;
  fromSessionId: string;
  toSessionId: string;
  baseDir?: string;
}): boolean {
  const destinationRoot = sessionsRoot(codexSessionHomeDir(input.toSessionId, input.baseDir));
  for (const root of rolloutRoots(input.fromSessionId, input.baseDir)) {
    const source = findCodexSessionFile(root, input.threadId);
    if (!source) continue;
    const destination = path.join(destinationRoot, path.relative(root, source));
    if (destination !== source) {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, destination);
    }
    return true;
  }
  return false;
}
