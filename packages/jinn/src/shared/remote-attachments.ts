import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assessFileRead } from "./file-read-policy.js";
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
 * The file-read policy is applied to every file first, so an attachment path
 * cannot be used to make a credential or session-config file readable by a
 * remote host that could not otherwise open it by path.
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

/** Copy `real` under the gateway home's linked `uploads/` and return its path
 *  relative to the home. Content-addressed so a repeat is a no-op, never a clash. */
function copyIntoUploads(real: string, home: string, sessionId: string): string {
  const bytes = fs.readFileSync(real);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const rel = path.join(remoteAttachmentsDir(sessionId), `${digest}-${segmentSafe(path.basename(real))}`);
  const dest = path.join(home, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) {
    const tmp = `${dest}.${process.pid}.part`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  }
  return rel;
}

/** The gateway-side file `requested` names, once vetted: it exists, is a regular
 *  file, and the file-read policy allows it. Throws naming the file otherwise. */
function vettedRealPath(requested: string, home: string): string {
  const name = path.basename(requested);
  let real: string;
  try {
    real = fs.realpathSync(requested);
  } catch {
    throw new Error(`cannot give "${name}" to the remote session: it does not exist on the gateway`);
  }
  if (!fs.statSync(real).isFile()) throw new Error(`cannot give "${name}" to the remote session: it is not a regular file`);
  const verdict = assessFileRead(real, { jinnHome: home });
  if (!verdict.allowed) {
    throw new Error(`cannot give "${name}" to the remote session: ${verdict.reason ?? "refused by the file-read policy"}`);
  }
  return real;
}

/**
 * The gateway paths of `attachments`, as the remote session at
 * `opts.sessionHome` can open them. Throws, naming the file, when one is
 * missing, is not a regular file, or is refused by the file-read policy: a turn
 * that references files the model cannot open is worse than one that fails.
 */
export function mapAttachmentsForRemote(attachments: readonly string[], opts: RemoteAttachmentOpts): string[] {
  const home = fs.realpathSync(opts.gatewayHome ?? resolveJinnHome());
  return attachments.map((requested) => {
    const real = vettedRealPath(requested, home);
    const rel = inside(real, home);
    const linked = rel !== undefined && !UNLINKED_HOME_ENTRIES.has(rel.split(path.sep)[0]!);
    return toSessionHome(opts.sessionHome, linked ? rel : copyIntoUploads(real, home, opts.sessionId));
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
