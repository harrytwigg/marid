import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expandPath, readLocalFileForIngestion } from "./file-read-policy.js";
import { resolveJinnHome } from "./home.js";

/**
 * Chat attachments for a session that runs on another host.
 *
 * An attachment arrives as a path on the GATEWAY's disk, and the prompt names
 * it verbatim, so on another machine it names nothing. What a remote session
 * does see is its staged home: a symlink farm over the sshfs mount of the
 * gateway's home (see FARM_SCRIPT), minus `gateway.json` and `tmp/`. So a file
 * under the gateway home is the same bytes at `<session home>/<same relative
 * path>`, and that is the path the remote model is given.
 *
 * Two kinds of file are not reachable that way and are COPIED into
 * `uploads/<date>/<session>/` first (the farm links `uploads/`, and the gateway's
 * upload sweep ages the copies out like any other upload):
 *  - files in `tmp/`, where the connectors (Telegram, Discord) download media,
 *    because `tmp/` is deliberately a real per-session directory on the remote;
 *  - files elsewhere on the gateway host, which the mount cannot reach at all.
 *
 * The file-read policy gates only the COPY. A file under a linked entry is
 * already openable by the remote at that path (the farm links `secrets/`,
 * `config.yaml*` and the rest for every session), so refusing it would hide
 * nothing and only drop the operator's message, while a local employee is given
 * the same file. A copy is NEW exposure, so it is read through the canonical
 * ingestion reader (lexical and real name judged, one O_NOFOLLOW descriptor,
 * inode check, size cap): a file the policy refuses is never copied.
 */

/** Top-level gateway-home entries the staged home does NOT link (FARM_SCRIPT). */
const UNLINKED_HOME_ENTRIES = new Set(["gateway.json", "tmp"]);

/** Where a copy made today for `sessionId` lands, relative to the gateway home.
 *  The same `uploads/<YYYY-MM-DD>/<session>/` layout a web upload gets, so the
 *  gateway's existing age sweep of date buckets removes the copies too. File
 *  names carry a content digest, so they cannot clash with a real upload. */
export function remoteAttachmentsDir(sessionId: string, now: Date = new Date()): string {
  return path.join("uploads", now.toISOString().slice(0, 10), segmentSafe(sessionId));
}

export interface RemoteAttachmentOpts {
  /** The remote session's staged home, as that host names it (a posix path). */
  sessionHome: string;
  /** The Jinn session id, which scopes any copies made. */
  sessionId: string;
  /** The gateway's instance home. Defaults to the running one. */
  gatewayHome?: string;
}

/** Not `sanitizeSessionId` / `uploadDir` (gateway/files.ts): shared/ cannot import
 *  the gateway layer, and a session id is a uuid, for which both agree. */
function segmentSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_";
}

function inside(candidate: string, root: string): string | undefined {
  const rel = path.relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel;
}

function toSessionHome(sessionHome: string, rel: string): string {
  return path.posix.join(sessionHome, ...rel.split(path.sep));
}

/** The most a copy will hold in memory and write. Copies are read whole on the
 *  gateway process, so this bounds the work; a linked file is never read here. */
export const REMOTE_COPY_MAX_BYTES = 25 * 1024 * 1024;

/** Create `uploads/<date>/<session>` under `home` one segment at a time and
 *  return it. `uploads/` and everything under it are writable by every remote
 *  session (the farm links it over a read-write mount), so the date and session
 *  segments must be real directories, never a planted link that would carry the
 *  write somewhere else; `uploads/` itself is the operator's to place. Throws
 *  if the directory does not resolve to exactly where it should. */
function copyDirectory(home: string, relDir: string): string {
  const [root, ...below] = relDir.split(path.sep);
  const uploads = path.join(home, root!);
  fs.mkdirSync(uploads, { recursive: true });
  let dir = uploads;
  for (const segment of below) {
    dir = path.join(dir, segment);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`"${relDir}" is not a plain directory`);
  }
  assertCopyDirectory(dir, path.join(fs.realpathSync.native(uploads), ...below));
  return dir;
}

function assertCopyDirectory(dir: string, expected: string): void {
  if (fs.realpathSync.native(dir) !== expected) throw new Error(`"${dir}" does not resolve inside uploads/`);
}

/** Copy `requested` under the gateway home's linked `uploads/` and return its
 *  path relative to the home. Content-addressed, so a repeat rewrites the same
 *  bytes under the same name, never a clash. Throws, naming the file, if the
 *  ingestion reader refuses it or the destination has been tampered with.
 *
 *  Every input to the destination name is predictable, so a remote session can
 *  plant a link at it ahead of time. The part file is therefore created with
 *  O_EXCL under an unguessable name (O_CREAT|O_EXCL never follows a link), and
 *  renamed over the destination, which replaces a planted link rather than
 *  writing through it. */
function copyIntoUploads(requested: string, home: string, sessionId: string): string {
  const read = readLocalFileForIngestion(requested, REMOTE_COPY_MAX_BYTES, { jinnHome: home });
  if (!read.ok) throw new Error(`cannot give "${path.basename(requested)}" to the remote session: ${read.error}`);
  const digest = crypto.createHash("sha256").update(read.buffer).digest("hex").slice(0, 16);
  const relDir = remoteAttachmentsDir(sessionId);
  const name = `${digest}-${segmentSafe(path.basename(read.realPath))}`;
  let dir: string;
  try {
    dir = copyDirectory(home, relDir);
  } catch (err) {
    throw new Error(`cannot give "${path.basename(requested)}" to the remote session: ${(err as Error).message}`);
  }
  const expected = fs.realpathSync.native(dir);
  const dest = path.join(dir, name);
  const part = `${dest}.${crypto.randomBytes(8).toString("hex")}.part`;
  let created = false;
  try {
    const fd = fs.openSync(part, "wx", 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, read.buffer);
    } finally {
      fs.closeSync(fd);
    }
    // Narrow the window in which the directory could have been swapped.
    assertCopyDirectory(dir, expected);
    fs.renameSync(part, dest);
    created = false;
  } catch (err) {
    throw new Error(`cannot give "${path.basename(requested)}" to the remote session: ${(err as Error).message}`);
  } finally {
    if (created) fs.rmSync(part, { force: true });
  }
  return path.join(relDir, name);
}

/** The gateway-side file `requested` names, canonicalised: it must exist and be
 *  a regular file. Throws naming the file otherwise. */
function existingRegularFile(requested: string): string {
  const name = path.basename(requested);
  let real: string;
  try {
    real = fs.realpathSync.native(path.resolve(expandPath(requested)));
  } catch {
    throw new Error(`cannot give "${name}" to the remote session: it does not exist on the gateway`);
  }
  if (!fs.statSync(real).isFile()) throw new Error(`cannot give "${name}" to the remote session: it is not a regular file`);
  return real;
}

/**
 * The gateway paths of `attachments`, as the remote session at
 * `opts.sessionHome` can open them. Throws, naming the file, when one is
 * missing, is not a regular file, or (for a copy) is refused by the file-read
 * policy or over {@link REMOTE_COPY_MAX_BYTES}: a turn that references files the
 * model cannot open is worse than one that fails.
 */
export function mapAttachmentsForRemote(attachments: readonly string[], opts: RemoteAttachmentOpts): string[] {
  const home = fs.realpathSync.native(opts.gatewayHome ?? resolveJinnHome());
  return attachments.map((requested) => {
    const real = existingRegularFile(requested);
    const rel = inside(real, home);
    const linked = rel !== undefined && !UNLINKED_HOME_ENTRIES.has(rel.split(path.sep)[0]!);
    return toSessionHome(opts.sessionHome, linked ? rel : copyIntoUploads(requested, home, opts.sessionId));
  });
}

/** `opts` with its attachments renamed for the remote session (a copy; `opts` is
 *  untouched). The turn's prompt is built from the result. */
export function withRemoteAttachments<T extends { attachments?: string[] }>(
  opts: T,
  sessionHome: string,
  sessionId: string,
): T {
  if (!opts.attachments?.length) return opts;
  return { ...opts, attachments: mapAttachmentsForRemote(opts.attachments, { sessionHome, sessionId }) };
}
