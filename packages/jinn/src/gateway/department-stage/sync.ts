import fs from "node:fs";
import path from "node:path";
import type { StageFile, StageFileSet } from "./file-set.js";

/**
 * Bring a stage directory to a generated file set without ever replacing it (FR-020a).
 *
 * The directory's path and inode stay put, because the transcript slug and the trust key
 * both derive from it and a session may be running in it. So the sync works file by file:
 *
 *  - the new file set is written to an incoming directory beside the stage directory, on
 *    the same filesystem, so every rename below is atomic;
 *  - only files are renamed: each file whose content or execute bit differs is renamed over
 *    the old one. A directory is made with `mkdir -p` and is never renamed over another; a
 *    whole directory is moved in only when nothing exists at its target yet;
 *  - a path whose type changes is removed first;
 *  - extras are removed afterwards, a file that left a kept skill included;
 *  - the incoming directory is deleted, and any older than an hour (a sync that died) is reaped.
 *
 * A running session therefore sees each file wholly old or wholly new, and its cwd never
 * disappears. Nothing is cached: the next sync compares against what is on disk.
 */

export interface SyncReport {
  /** Files renamed in, as paths relative to the stage directory. A directory moved in whole is listed once. */
  written: string[];
  /** Paths removed as extras or to change type. */
  removed: string[];
}

const STALE_INCOMING_MS = 60 * 60 * 1000;
const INCOMING_NAME = /^\..+\.incoming-[A-Za-z0-9]{6}$/;

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function remove(target: string, rel: string, report: SyncReport): void {
  fs.rmSync(target, { recursive: true, force: true });
  report.removed.push(rel);
}

/** Incoming directories a sync that died left behind. */
function reapStaleIncoming(root: string, now: number): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !INCOMING_NAME.test(entry.name)) continue;
    const stat = lstatOrNull(path.join(root, entry.name));
    if (stat && now - stat.mtimeMs > STALE_INCOMING_MS) fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
}

function writeIncoming(incoming: string, files: StageFileSet): void {
  for (const [rel, file] of files) {
    const target = path.join(incoming, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, { mode: file.executable ? 0o755 : 0o644 });
    fs.chmodSync(target, file.executable ? 0o755 : 0o644);
  }
}

/** Every directory the file set implies, shallowest first, as POSIX paths. */
function impliedDirs(files: StageFileSet): string[] {
  const dirs = new Set<string>();
  for (const rel of files.keys()) {
    const parts = rel.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function sameFile(target: string, stat: fs.Stats, file: StageFile): boolean {
  if (!stat.isFile() || stat.size !== file.content.length || ((stat.mode & 0o100) !== 0) !== file.executable) return false;
  return fs.readFileSync(target).equals(file.content);
}

/** Make the directories of the file set. A directory nothing exists at yet is moved in whole from `incoming`. Returns the directories moved in. */
function placeDirs(stageDir: string, incoming: string, dirs: string[], report: SyncReport): string[] {
  const moved: string[] = [];
  for (const rel of dirs) {
    if (moved.some((m) => rel.startsWith(`${m}/`))) continue;
    const target = path.join(stageDir, ...rel.split("/"));
    const stat = lstatOrNull(target);
    if (stat?.isDirectory()) continue;
    if (stat) remove(target, rel, report);
    if (lstatOrNull(path.dirname(target))?.isDirectory()) {
      fs.renameSync(path.join(incoming, ...rel.split("/")), target);
      moved.push(rel);
      report.written.push(rel);
    } else {
      fs.mkdirSync(target, { recursive: true });
    }
  }
  return moved;
}

function placeFiles(stageDir: string, incoming: string, files: StageFileSet, moved: string[], report: SyncReport): void {
  for (const [rel, file] of files) {
    if (moved.some((m) => rel.startsWith(`${m}/`))) continue;
    const target = path.join(stageDir, ...rel.split("/"));
    const stat = lstatOrNull(target);
    if (stat?.isDirectory()) remove(target, rel, report);
    else if (stat && sameFile(target, stat, file)) continue;
    fs.renameSync(path.join(incoming, ...rel.split("/")), target);
    report.written.push(rel);
  }
}

/** Remove whatever is not in the set: files, links, directories, and files left in a kept skill. */
function removeExtras(dir: string, prefix: string, files: StageFileSet, dirs: ReadonlySet<string>, report: SyncReport): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory() && dirs.has(rel)) removeExtras(absolute, rel, files, dirs, report);
    else if (!(entry.isFile() && files.has(rel))) remove(absolute, rel, report);
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The sync deletes extras and a session's cwd is whatever this resolves to, so a root that
 * is a link, or a stage directory that lands anywhere but directly under the real root or
 * inside a `forbidden` tree (the instance home, say), is refused rather than followed.
 */
function assertContained(root: string, stageDir: string, forbidden: readonly string[]): void {
  const rootStat = lstatOrNull(root);
  if (rootStat?.isSymbolicLink()) throw new Error(`${root} is a symbolic link`);
  const realRoot = fs.realpathSync(root);
  const realStage = fs.realpathSync(stageDir);
  if (realStage !== path.join(realRoot, path.basename(stageDir))) throw new Error(`${stageDir} resolves to ${realStage}, outside ${realRoot}`);
  for (const tree of forbidden) {
    const real = lstatOrNull(tree) ? fs.realpathSync(tree) : path.resolve(tree);
    if (isWithin(realStage, real) || isWithin(realRoot, real)) throw new Error(`${stageDir} resolves inside ${real}`);
  }
}

export function syncStageDir(stageDir: string, files: StageFileSet, now: number = Date.now(), forbidden: readonly string[] = []): SyncReport {
  const report: SyncReport = { written: [], removed: [] };
  const root = path.dirname(stageDir);
  if (lstatOrNull(root)?.isSymbolicLink()) throw new Error(`${root} is a symbolic link`);
  fs.mkdirSync(root, { recursive: true });
  // A link or a file where the directory belongs is not the directory: nothing is lost by replacing it.
  const existing = lstatOrNull(stageDir);
  if (existing && !existing.isDirectory()) fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  assertContained(root, stageDir, forbidden);
  reapStaleIncoming(root, now);

  const incoming = fs.mkdtempSync(path.join(root, `.${path.basename(stageDir)}.incoming-`));
  try {
    writeIncoming(incoming, files);
    const dirs = impliedDirs(files);
    const moved = placeDirs(stageDir, incoming, dirs, report);
    placeFiles(stageDir, incoming, files, moved, report);
    removeExtras(stageDir, "", files, new Set(dirs), report);
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
  return report;
}
