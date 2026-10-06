import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveJinnHome } from "./home.js";
import { protectedClaudeConfigDirs } from "./claude-profile.js";
import { homeGuard, isInsidePath, protectedHomeEntry, realpathOrResolved, type HomeGuard } from "./protected-home-entries.js";

/**
 * The standing file-read policy and the policy-gated local-file reader, shared
 * by the gateway and the built-in MCP server.
 *
 * The gateway applies it when a caller names a path for the GATEWAY to read.
 * The MCP server applies the same function, byte for byte, when a session names
 * a file on its OWN host for upload — a session on a remote build host reads
 * its file locally and sends the bytes, so the policy has to travel with the
 * read rather than stay behind on the gateway. Kept free of gateway imports
 * (registry, busboy, sqlite) so the MCP process can load it cheaply.
 *
 * `jinnHome` names the instance home whose `secrets/` is off limits. The
 * gateway passes its own JINN_HOME; the MCP server defaults to its process's
 * home, which on a remote host is the staging dir whose entries symlink into
 * the gateway mount.
 */

export interface FileReadAssessment { allowed: boolean; reason?: string }

export interface FileReadPolicyOptions {
  authenticated?: boolean;
  jinnHome?: string;
}

export function expandPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function pathSegments(absPath: string): string[] {
  return path.resolve(absPath).split(path.sep).filter(Boolean).map((s) => s.toLowerCase());
}

const PRIVATE_KEY_OR_TOKEN = /^\.?(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.key|auth\.json|credentials(?:\.json)?|token(?:\.json|\.txt)?)$/i;

/** Refusals decided by the file's own name. */
function assessBasename(base: string): FileReadAssessment | null {
  if (base.startsWith(".env")) return { allowed: false, reason: "Refusing to read environment secret files" };
  // The leading dot is optional: Claude Code's OAuth token lives in `.credentials.json`,
  // which an anchored `credentials(\.json)?` never matched.
  if (PRIVATE_KEY_OR_TOKEN.test(base)) return { allowed: false, reason: "Refusing to read private keys or token files" };
  return null;
}

/** Refusals decided by the directory the file sits in. */
function assessLocation(resolved: string, base: string, guard: HomeGuard): FileReadAssessment | null {
  const home = realpathOrResolved(os.homedir());
  if (isInsidePath(resolved, path.join(home, ".ssh"))) return { allowed: false, reason: "Refusing to read SSH secrets" };
  const protectedEntry = protectedHomeEntry(resolved, guard);
  if (protectedEntry === "secrets") return { allowed: false, reason: "Refusing to read Jinn secrets" };
  if (protectedEntry) return { allowed: false, reason: "Refusing to read Jinn credential or session-config files" };
  // A literal ".claude" segment covers project-local dirs; the resolved config dir
  // covers the real one, which CLAUDE_CONFIG_DIR can move anywhere (the container
  // does exactly that).
  const segments = pathSegments(resolved);
  const claudeConfigDirs = protectedClaudeConfigDirs().map(realpathOrResolved);
  if ((segments.includes(".claude") || claudeConfigDirs.some((dir) => isInsidePath(resolved, dir))) && base.startsWith("auth")) {
    return { allowed: false, reason: "Refusing to read Claude auth files" };
  }
  if (segments.includes(".codex") && base === "auth.json") return { allowed: false, reason: "Refusing to read Codex auth files" };
  return null;
}

function assessSingleResolvedPath(resolved: string, guard: HomeGuard): FileReadAssessment {
  const base = path.basename(resolved).toLowerCase();
  return assessBasename(base) ?? assessLocation(resolved, base, guard) ?? { allowed: true };
}

export function assessFileRead(absPath: string, opts: FileReadPolicyOptions = {}): FileReadAssessment {
  const guard = homeGuard(opts.jinnHome ?? resolveJinnHome());
  const requested = path.resolve(expandPath(absPath));
  const candidates = [requested];
  const real = realpathOrResolved(requested);
  if (real !== requested) candidates.push(real);
  for (const candidate of candidates) {
    const assessment = assessSingleResolvedPath(candidate, guard);
    if (!assessment.allowed) return assessment;
  }
  return { allowed: true };
}

export function sameInode(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export type LocalFileIngestion =
  | { ok: true; buffer: Buffer<ArrayBuffer>; realPath: string }
  | { ok: false; status: 400 | 403 | 404 | 413; error: string };

type IngestionRefusal = Extract<LocalFileIngestion, { ok: false }>;

/** Read exactly `size` bytes from an open descriptor; false on a short read. */
function readExactly(fd: number, buffer: Buffer): boolean {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (read <= 0) break;
    offset += read;
  }
  return offset === buffer.length;
}

function ingestionErrorFor(err: unknown, requestedPath: string): IngestionRefusal {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, status: 404, error: `file not found: ${requestedPath}` };
  if (code === "ELOOP") return { ok: false, status: 403, error: `${requestedPath} changed during open and was refused` };
  return { ok: false, status: 400, error: err instanceof Error ? err.message : "read failed" };
}

/** Everything that can refuse an opened file before its bytes are read. */
/** One file as it was asked for (`requestedPath`, verbatim for messages), as
 *  named (`lexicalPath`, resolved but unfollowed) and as opened (`realPath`). */
interface IngestionTarget {
  requestedPath: string;
  lexicalPath: string;
  realPath: string;
}

function refuseOpened(
  fd: number,
  { requestedPath, lexicalPath, realPath }: IngestionTarget,
  maxBytes: number,
  jinnHome: string | undefined,
): IngestionRefusal | fs.Stats {
  const openedStat = fs.fstatSync(fd);
  if (!openedStat.isFile()) return { ok: false, status: 400, error: `not a file: ${requestedPath}` };
  // The opened descriptor must still be what the canonical path names — a
  // swap between realpath and open surfaces as an inode mismatch.
  if (!sameInode(openedStat, fs.statSync(realPath))) {
    return { ok: false, status: 403, error: `${requestedPath} changed during open and was refused` };
  }
  // The OPENED file is what is judged (review F1): `realPath` — the canonical
  // path this descriptor was opened from — is always a candidate, so a link
  // swapped after the open cannot substitute a benign target. The name it was asked for
  // is judged too, so a link BELOW a protected entry (tmp/mcp/<sid> -> elsewhere)
  // is refused by that name; either refusal refuses.
  for (const judged of [realPath, lexicalPath]) {
    const assessment = assessFileRead(judged, { authenticated: true, jinnHome });
    if (!assessment.allowed) {
      return { ok: false, status: 403, error: assessment.reason || "File read blocked by security policy" };
    }
  }
  if (openedStat.size > maxBytes) {
    return { ok: false, status: 413, error: `attachment exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB per-file limit` };
  }
  return openedStat;
}

/** Canonicalize and open the file ONCE (O_NOFOLLOW on the canonical path),
 *  run every refusal against that descriptor, then hand it to `use`. */
function withVettedDescriptor<T>(
  requestedPath: string,
  maxBytes: number,
  jinnHome: string | undefined,
  use: (fd: number, realPath: string, stat: fs.Stats) => T | IngestionRefusal,
): T | IngestionRefusal {
  const requested = path.resolve(expandPath(requestedPath));
  let fd: number | null = null;
  try {
    const realPath = fs.realpathSync.native(requested);
    fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = refuseOpened(fd, { requestedPath, lexicalPath: requested, realPath }, maxBytes, jinnHome);
    return opened instanceof fs.Stats ? use(fd, realPath, opened) : opened;
  } catch (err) {
    return ingestionErrorFor(err, requestedPath);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Everything {@link readLocalFileForIngestion} would refuse, without reading
 * the bytes — so a caller can vet a batch of files before doing anything that
 * cannot be undone. The read itself re-checks on its own descriptor.
 */
export function vetLocalFileForIngestion(
  requestedPath: string,
  maxBytes: number,
  opts: Pick<FileReadPolicyOptions, "jinnHome"> = {},
): IngestionRefusal | { ok: true; realPath: string; size: number } {
  return withVettedDescriptor(requestedPath, maxBytes, opts.jinnHome, (_fd, realPath, stat) => ({ ok: true as const, realPath, size: stat.size }));
}

/**
 * Read a caller-named local file for ingestion (e.g. attachment uploads) under
 * the standing file-read policy. Symlink-swap-proof: the source is
 * canonicalized and opened ONCE (O_NOFOLLOW on the canonical path), the
 * assessment runs against that opened real path, the size cap uses fstat on
 * the SAME descriptor, and the bytes are read from that descriptor — a path
 * swapped between checks is detected by inode comparison and refused.
 */
export function readLocalFileForIngestion(
  requestedPath: string,
  maxBytes: number,
  opts: Pick<FileReadPolicyOptions, "jinnHome"> = {},
): LocalFileIngestion {
  return withVettedDescriptor(requestedPath, maxBytes, opts.jinnHome, (fd, realPath, stat): LocalFileIngestion => {
    const buffer = Buffer.alloc(stat.size);
    if (!readExactly(fd, buffer)) {
      return { ok: false, status: 403, error: `${requestedPath} changed during read and was refused` };
    }
    return { ok: true, buffer, realPath };
  });
}
