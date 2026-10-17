import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_CODENAME, NAMES, currentInstanceName, type Names } from "../shared/codename.js";
import { acquireHomeLock } from "./home-lock.js";
import { decide, kindOf, linkToCurrent, pairFor } from "./home-state.js";
import { clearPendingMove, readPendingMove, writePendingMove } from "./home-pending.js";
import { claudeConfigDirsOf } from "./claude-profile-dirs.js";
import { moveTranscripts } from "../shared/claude-transcript-move.js";
import { renameStageRoot } from "./stage-rename.js";
import { recordInstanceRenamed, type DirectoryOptions } from "./directory.js";
import { backupRootFor, renameBackupDirs } from "./backup-rename.js";

/**
 * Moving an instance's home from the directory an earlier codename gave it (`~/.jinn-x`) to the one this
 * build names (`~/.<codename>-x`).
 *
 * The home is renamed, not copied, so the sessions database and every file keep their inodes, and a
 * symlink is left at the old path so absolute paths recorded inside (attachments, a configured mount)
 * still resolve. Because Claude Code files its conversations by the physical working directory, the
 * project directories for the home and for each department stage directory move too, in every profile;
 * a symlink does not help there. The instance's registry entry and the stage containers move with it.
 *
 * It is done only while nothing is running there, under a lock, and after a snapshot of the home; if
 * any of that fails the home is left where it is and used under its old name, and `doctor` says why.
 * Run again, it finds the move done. A home that is a mount point (a container's volume) is never
 * moved: its path stays and only the names change.
 */

export interface HomeRenameDeps {
  names?: Names;
  now?: () => Date;
  homeDir?: string;
  /** Whether a gateway is running at `home`. Defaults to its pid files. */
  gatewayRunning?: (home: string) => boolean;
  /** Snapshot `home` before it moves; rejects if it could not. Defaults to the backup run's snapshot. */
  backup?: (name: string, home: string) => Promise<string | undefined>;
  claudeConfigDirs?: (home: string) => string[];
  isMountPoint?: (directory: string) => boolean;
  registry?: DirectoryOptions;
  log?: (message: string) => void;
  lockTimeoutMs?: number;
}

export interface HomeMoveReceipt {
  from: string;
  to: string;
  at: string;
  transcripts: number;
  stageRoot?: { from: string; to: string; departments: string[]; transcripts: number };
  backup?: string;
}

export type HomeRenameOutcome =
  | { kind: "nothing"; home: string }
  | { kind: "moved"; home: string; receipt: HomeMoveReceipt }
  | { kind: "kept"; home: string; reason: string; /** Another live process is mid-move: starting a gateway here now would be moved from under. */ blocking?: boolean }
  | { kind: "conflict"; home: string; legacyHome: string; currentHome: string };

/** Where the receipt of a move is kept, inside the moved home. */
export const HOME_MOVE_RECEIPT = path.join("state", "home-move.json");

function defaultIsMountPoint(directory: string): boolean {
  try {
    return fs.statSync(directory).dev !== fs.statSync(path.dirname(directory)).dev;
  } catch {
    return false;
  }
}

function readPid(file: string): number | undefined {
  try {
    const raw = fs.readFileSync(file, "utf-8").trim();
    const value = file.endsWith(".json") ? (JSON.parse(raw) as { pid?: unknown }).pid : Number.parseInt(raw, 10);
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A pid that is alive and, where the platform lets us see, is one of this program's (a recycled pid is not a gateway). */
function looksLikeGateway(pid: number, names: Names): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    return [LEGACY_CODENAME, names.codename].some((name) => command.includes(name));
  } catch {
    return true;
  }
}

function defaultGatewayRunning(home: string, names: Names): boolean {
  return ["gateway.pid", "gateway.json"].some((name) => {
    const pid = readPid(path.join(home, name));
    return pid !== undefined && pid !== process.pid && looksLikeGateway(pid, names);
  });
}

async function defaultBackup(name: string, home: string, homeDir: string, now: Date): Promise<string | undefined> {
  const { createSnapshot } = await import("../backup/snapshot.js");
  const { resolveArchiveCodec } = await import("../backup/codec.js");
  const { backupRootFor } = await import("./backup-rename.js");
  const report = await createSnapshot({ name, home }, backupRootFor(homeDir), now, resolveArchiveCodec());
  if (report.status !== "ok") throw new Error(report.error ?? "the snapshot failed");
  return report.path;
}

/**
 * Settle which home `home` (as named by the environment, the registry or `-i`) should be used as, moving
 * it if that is needed and safe. Returns the path to use and what was done.
 */
export async function renameHomeIfNeeded(home: string, deps: HomeRenameDeps = {}): Promise<HomeRenameOutcome> {
  const names = deps.names ?? NAMES;
  const log = deps.log ?? (() => undefined);
  const { current, legacy } = pairFor(home, names);
  if (current === legacy) return { kind: "nothing", home: path.resolve(home) };
  // A move that was started and not finished (the process died): finish it before anything else looks at the home.
  if (readPendingMove(current)) return resumeMove(current, deps, names, log);
  // The old path, now a link to the moved home: use the real one, so one directory has one identity and one stage root.
  if (linkToCurrent(legacy, current)) return { kind: "nothing", home: current };
  const verdict = decide(legacy, current);
  if (verdict === "conflict") return { kind: "conflict", home: legacy, legacyHome: legacy, currentHome: current };
  if (verdict === "kept-link") return { kind: "kept", home: legacy, reason: `${legacy} is a link to somewhere else, so it was left alone` };
  if (verdict === "nothing") return { kind: "nothing", home: current };
  return moveHome(legacy, current, deps, names, log);
}

async function moveHome(
  legacy: string,
  current: string,
  deps: HomeRenameDeps,
  names: Names,
  log: (message: string) => void,
): Promise<HomeRenameOutcome> {
  const homeDir = deps.homeDir ?? os.homedir();
  const now = (deps.now ?? (() => new Date()))();
  const kept = (reason: string): HomeRenameOutcome => ({ kind: "kept", home: legacy, reason });
  if ((deps.isMountPoint ?? defaultIsMountPoint)(legacy)) return kept(`${legacy} is a mount point, so its path stays`);
  if (gatewayRunningAt(legacy, deps, names)) {
    return kept(`a gateway is running at ${legacy}: stop it, then start it again to move the home to ${current}`);
  }
  const lock = await acquireHomeLock(path.join(path.dirname(legacy), `.${names.codename}-home-move.lock`), deps.lockTimeoutMs);
  if (!lock) return { kind: "kept", home: legacy, reason: `another process is moving ${legacy}`, blocking: true };
  try {
    // Someone else may have finished the move while this one waited.
    if (decide(legacy, current) !== "move") return renameHomeIfNeeded(legacy, { ...deps, lockTimeoutMs: 0 });
    return await moveLocked(legacy, current, { deps, names, log, homeDir, now });
  } finally {
    lock.release();
  }
}

function gatewayRunningAt(home: string, deps: HomeRenameDeps, names: Names): boolean {
  return (deps.gatewayRunning ?? ((dir) => defaultGatewayRunning(dir, names)))(home);
}

interface MoveContext {
  deps: HomeRenameDeps;
  names: Names;
  log: (message: string) => void;
  homeDir: string;
  now: Date;
}

async function moveLocked(legacy: string, current: string, context: MoveContext): Promise<HomeRenameOutcome> {
  const { deps, homeDir, now } = context;
  const kept = (reason: string): HomeRenameOutcome => ({ kind: "kept", home: legacy, reason });
  const instance = path.basename(legacy).replace(/^\./, "");
  let backup: string | undefined;
  try {
    backup = await (deps.backup ?? ((name, dir) => defaultBackup(name, dir, homeDir, now)))(instance, legacy);
  } catch (error) {
    return kept(`it was not moved because the backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The snapshot can take minutes: a gateway that started meanwhile (the lock keeps other movers out, not a plain start) is not moved from under.
  if (gatewayRunningAt(legacy, deps, context.names)) return kept(`a gateway started at ${legacy} while it was being backed up, so it was not moved`);
  const physicalLegacy = fs.realpathSync.native(legacy);
  const configDirs = (deps.claudeConfigDirs ?? claudeConfigDirsOf)(legacy);
  const facts: MoveFacts = { legacy, current, instance, physicalLegacy, configDirs, backup };
  try {
    writePendingMove(legacy, { ...facts, at: now.toISOString() });
    fs.renameSync(legacy, current);
  } catch (error) {
    clearPendingMove(legacy);
    return kept(`it could not be renamed (${(error as NodeJS.ErrnoException).code ?? "error"}): ${(error as Error).message}`);
  }
  const { receipt, complete } = followTheMove(facts, context);
  settlePending(current, complete, context.log);
  context.log(`Moved ${legacy} to ${current}; a link remains at the old path.`);
  return { kind: "moved", home: current, receipt };
}

/** The note stays while any follow-up step failed, so the next command tries those steps again. */
function settlePending(home: string, complete: boolean, log: (message: string) => void): void {
  if (complete) clearPendingMove(home);
  else log(`Some steps of the move to ${home} did not finish; they are tried again at the next command.`);
}

/** Finish a move whose process died after the rename: the same follow-up steps, from the note it left. */
async function resumeMove(current: string, deps: HomeRenameDeps, names: Names, log: (message: string) => void): Promise<HomeRenameOutcome> {
  const lock = await acquireHomeLock(path.join(path.dirname(current), `.${names.codename}-home-move.lock`), deps.lockTimeoutMs);
  if (!lock) return { kind: "nothing", home: current };
  try {
    const pending = readPendingMove(current);
    if (!pending) return { kind: "nothing", home: current };
    const context: MoveContext = { deps, names, log, homeDir: deps.homeDir ?? os.homedir(), now: (deps.now ?? (() => new Date()))() };
    const { receipt, complete } = followTheMove({ ...pending, backup: pending.backup }, context);
    settlePending(current, complete, log);
    log(`${complete ? "Finished" : "Went on with"} the move of ${pending.legacy} to ${current} that an earlier run left half done.`);
    return { kind: "moved", home: current, receipt };
  } finally {
    lock.release();
  }
}

interface MoveFacts {
  legacy: string;
  current: string;
  instance: string;
  physicalLegacy: string;
  configDirs: string[];
  backup: string | undefined;
}

/** Everything that has to follow a home that has just been renamed: the link, the record, the conversations, the stage root, the snapshots, the registry. */
function followTheMove(facts: MoveFacts, context: MoveContext): { receipt: HomeMoveReceipt; complete: boolean } {
  const { legacy, current, instance, physicalLegacy, configDirs, backup } = facts;
  const { deps, names, log, homeDir, now } = context;
  let complete = true;
  const warn = (message: string): void => { complete = false; log(message); };
  linkOldPath(legacy, current, log);
  const physicalCurrent = fs.realpathSync.native(current);
  rewriteGatewayRecord(current, physicalCurrent);
  const transcripts = moveTranscripts(physicalLegacy, physicalCurrent, configDirs, warn).length;
  const stage = safely(() => renameStageRoot(legacy, current, configDirs, { names, onError: warn, physicalLegacyHome: physicalLegacy }), warn);
  const currentName = currentInstanceName(instance, names);
  safely(() => renameBackupDirs({ homeDir, legacyName: instance, currentName, names }), warn);
  safely(() => recordInstanceRenamed({ fromHome: legacy, toHome: current, name: instance }, deps.registry), warn);
  const receipt: HomeMoveReceipt = {
    from: legacy,
    to: current,
    at: now.toISOString(),
    transcripts: transcripts + (stage?.transcripts ?? 0),
    ...(stage ? { stageRoot: { from: stage.from, to: stage.to, departments: stage.departments, transcripts: stage.transcripts } } : {}),
    ...(backup ? { backup: path.join(backupRootFor(homeDir, names), currentName, path.basename(backup)) } : {}),
  };
  safely(() => writeReceipt(current, receipt), warn);
  return { receipt, complete };
}

function safely<T>(action: () => T, warn: (message: string) => void): T | undefined {
  try {
    return action();
  } catch (error) {
    warn(`rename step failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function linkOldPath(legacy: string, current: string, log: (message: string) => void): void {
  if (kindOf(legacy) !== "absent") return;
  try {
    fs.symlinkSync(current, legacy, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    log(`Could not leave a link at ${legacy}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The gateway record names the home by identity; the move changed it. Its pids are stale either way. */
function rewriteGatewayRecord(home: string, identity: string): void {
  const file = path.join(home, "gateway.json");
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (typeof record.home !== "string" || record.home === identity) return;
    fs.writeFileSync(file, JSON.stringify({ ...record, home: identity }, null, 2), { mode: 0o600 });
  } catch { /* no record, or not JSON: the gateway writes a fresh one */ }
}

function writeReceipt(home: string, receipt: HomeMoveReceipt): void {
  const file = path.join(home, HOME_MOVE_RECEIPT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

/** The receipt a move left in `home`, or undefined if it never moved. */
export function readHomeMoveReceipt(home: string): HomeMoveReceipt | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, HOME_MOVE_RECEIPT), "utf-8")) as HomeMoveReceipt;
  } catch {
    return undefined;
  }
}
