import fs from "node:fs";
import path from "node:path";

/**
 * A note left inside a home just before it is renamed, naming what the rename has to be followed by. If the
 * process dies between the rename and the last follow-up step, the next start finds the note in the moved
 * home and finishes the job; without it the old path would be gone, nothing would look unfinished, and the
 * conversations would stay filed under the old working directory.
 */
export const HOME_MOVE_PENDING = path.join("state", "home-move-pending.json");

export interface PendingMove {
  legacy: string;
  current: string;
  instance: string;
  physicalLegacy: string;
  configDirs: string[];
  backup?: string;
  at: string;
}

/** Throws if the note cannot be written: a move that could not be made resumable is not started. */
export function writePendingMove(home: string, pending: PendingMove): void {
  const file = path.join(home, HOME_MOVE_PENDING);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
}

export function readPendingMove(home: string): PendingMove | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, HOME_MOVE_PENDING), "utf-8")) as Partial<PendingMove>;
    const complete = [value.legacy, value.current, value.instance, value.physicalLegacy].every((field) => typeof field === "string");
    return complete && Array.isArray(value.configDirs) ? (value as PendingMove) : undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingMove(home: string): void {
  fs.rmSync(path.join(home, HOME_MOVE_PENDING), { force: true });
}
