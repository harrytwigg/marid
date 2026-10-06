import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import path from "node:path";
import { getSession } from "../sessions/registry.js";
import { orgRegistry } from "./org-registry.js";
import { employeeRemoteTarget, isRemoteTarget } from "../shared/remote-target.js";
import { remoteScopeFor } from "../sessions/session-cwd.js";
import { engineSupportsRemote } from "../shared/models.js";
import { expandPath, readLocalFileForIngestion, vetLocalFileForIngestion } from "../shared/file-read-policy.js";
import { hasControlBytes } from "../shared/sanitize.js";
import { redactText } from "../shared/redact.js";
import { JINN_HOME } from "../shared/paths.js";
import { readRemoteSessionFile, type RemoteFileOp, type RemoteFileResult } from "../engines/remote-file-read.js";
import { handleSessionAttachment, isBinaryMime, MAX_READ_SIZE, mimeFromFilename } from "./files.js";
import { UNIDENTIFIED_TOOL_CALL_ERROR } from "../mcp/identity.js";
import type { CallerIdentity } from "./session-comm-guards.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";

/**
 * GET /api/sessions/:id/files/read?path=  — preview one file a session named.
 * GET /api/sessions/:id/files/raw?path=   — the bytes of one image, for <img>.
 *
 * Chat file links name paths as the AGENT saw them: absolute, `~/`, or relative
 * to its working directory, on whichever host the session runs. The managed
 * readers (`/api/files/read`, `/api/knowledge/read`) only know the instance's
 * own roots, so every other path used to open an error. This route resolves the
 * path where the session lives: on the gateway for a local employee (relative
 * to JINN_HOME, its cwd), and over ssh on the build host for a remote one
 * (relative to its `remoteCwd`; see engines/remote-file-read.ts).
 *
 * Operator only. A capability-bound session is refused, so this is never a way
 * for an agent to read gateway files it could not otherwise reach; the operator
 * already holds a terminal on both hosts. The standing file-read policy still
 * applies on top (secrets, credentials, keys, session configs), on the host
 * that holds the file.
 */

/** Largest image the raw route serves. Screenshots are the usual case. */
export const MAX_RAW_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const NUL_SCAN_BYTES = 8192;

/** Image types a browser renders without running anything. SVG is
 *  deliberately absent: it is a document that can carry script. */
const RAW_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type HostRead = (op: RemoteFileOp, maxBytes: number) => Promise<RemoteFileResult>;

function localHostRead(requested: string): HostRead {
  const expanded = expandPath(requested);
  const target = path.isAbsolute(expanded) ? expanded : path.resolve(JINN_HOME, expanded);
  return async (op, maxBytes) => {
    const opts = { jinnHome: JINN_HOME };
    if (op === "vet") return vetLocalFileForIngestion(target, maxBytes, opts);
    const read = readLocalFileForIngestion(target, maxBytes, opts);
    return read.ok ? { ok: true, realPath: read.realPath, size: read.buffer.length, buffer: read.buffer } : read;
  };
}

/** Where to read for this session, or the reason it cannot be read at all. */
function hostReadFor(sessionId: string, requested: string, context: ApiContext): { read: HostRead; host?: string } | { status: number; error: string } {
  const session = getSession(sessionId);
  if (!session) return { status: 404, error: "Session not found" };
  // The host comes from the employee's CURRENT config, not from where this
  // session last ran: an employee moved between hosts reads old links from the
  // new one. Sessions record no host of their own to prefer.
  const employee = session.employee ? orgRegistry(context.getConfig()).get(session.employee) : undefined;
  // A scoped session runs in its department's stage directory, so relative links resolve there.
  const target = employeeRemoteTarget(employee, remoteScopeFor(context.getConfig().remote, session));
  if (!isRemoteTarget(target)) return { read: localHostRead(requested) };
  if (!engineSupportsRemote(session.engine)) {
    return { status: 409, error: `${session.engine} sessions do not run on ${target.remoteHost}` };
  }
  const engine = session.engine;
  return {
    host: target.remoteHost,
    read: (op, maxBytes) => readRemoteSessionFile({ target, sessionId, engine, requestedPath: requested, op, maxBytes }),
  };
}

function requestedPathError(requested: string | null): string | null {
  if (!requested) return "path query parameter is required";
  if (requested.length > MAX_PATH_LENGTH) return "path is too long";
  if (hasControlBytes(requested)) return "path contains control bytes";
  return null;
}

/** The MIME a file's extension cannot vouch for: `.py`, `.sh`, `.log`,
 *  `Dockerfile` and every other name outside the table. Its content decides. */
const UNKNOWN_MIME = "application/octet-stream";

function hasNulByte(buffer: Buffer): boolean {
  return buffer.subarray(0, NUL_SCAN_BYTES).includes(0);
}

async function previewJson(read: HostRead, requested: string, host: string | undefined): Promise<{ status: number; body: unknown }> {
  const vetted = await read("vet", Number.MAX_SAFE_INTEGER);
  if (!vetted.ok) return { status: vetted.status, body: { error: vetted.error } };
  const mime = mimeFromFilename(vetted.realPath);
  const base = { path: requested, resolvedPath: vetted.realPath, ...(host ? { host } : {}), mime, size: vetted.size };
  if (isBinaryMime(mime) && mime !== UNKNOWN_MIME) {
    const previewable = RAW_IMAGE_MIMES.has(mime) && vetted.size <= MAX_RAW_IMAGE_SIZE;
    return { status: 200, body: { ...base, tooLarge: false, binary: true, previewable } };
  }
  if (vetted.size > MAX_READ_SIZE) return { status: 200, body: { ...base, tooLarge: true, binary: false } };
  const opened = await read("read", MAX_READ_SIZE);
  if (!opened.ok) return { status: opened.status, body: { error: opened.error } };
  return { status: 200, body: textPreview(base, opened.buffer ?? Buffer.alloc(0)) };
}

/** A file small enough to show: binary if it has a NUL byte up front, else
 *  text — redacted like every other text read the gateway serves (files.ts),
 *  since an agent's log or script can carry a token it printed. */
function textPreview(base: { mime: string; size: number }, buffer: Buffer): Record<string, unknown> {
  const shown = { ...base, size: buffer.length, tooLarge: false };
  if (hasNulByte(buffer)) return { ...shown, binary: true, previewable: false };
  const mime = base.mime === UNKNOWN_MIME ? "text/plain" : base.mime;
  return { ...shown, mime, binary: false, content: redactText(buffer.toString("utf-8")) };
}

async function sendRawImage(res: ServerResponse, read: HostRead): Promise<void> {
  // Judge the type before moving any bytes: a 415 should not cost a 20MB
  // transfer (base64 over ssh for a remote host). The read re-checks it on the
  // file it actually opened, in case the name was swapped in between.
  const vetted = await read("vet", Number.MAX_SAFE_INTEGER);
  if (!vetted.ok) return json(res, { error: vetted.error }, vetted.status);
  if (!RAW_IMAGE_MIMES.has(mimeFromFilename(vetted.realPath))) return json(res, { error: "Only PNG, JPEG, GIF and WebP images are served raw" }, 415);
  const opened = await read("read", MAX_RAW_IMAGE_SIZE);
  if (!opened.ok) return json(res, { error: opened.error }, opened.status);
  const mime = mimeFromFilename(opened.realPath);
  if (!RAW_IMAGE_MIMES.has(mime)) return json(res, { error: "Only PNG, JPEG, GIF and WebP images are served raw" }, 415);
  const buffer = opened.buffer ?? Buffer.alloc(0);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": buffer.length,
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  res.end(buffer);
}

export interface SessionFileReadRequest {
  sessionId: string;
  mode: "read" | "raw";
  url: URL;
  /** Resolved by api.ts the way every operator UI route is, so a same-origin
   *  browser on an instance without auth counts as the operator. */
  caller: CallerIdentity;
}

export async function handleSessionFileRead(
  res: ServerResponse,
  { sessionId, mode, url, caller }: SessionFileReadRequest,
  context: ApiContext,
): Promise<void> {
  if (caller.kind === "session") {
    return json(res, { error: "session file read is operator-only; capability-bound sessions cannot read files through the gateway" }, 403);
  }
  if (caller.kind !== "operator") return json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
  const requested = url.searchParams.get("path");
  const shapeError = requestedPathError(requested);
  if (shapeError) return badRequest(res, shapeError);
  const where = hostReadFor(sessionId, requested!, context);
  if ("error" in where) return where.status === 404 ? notFound(res) : json(res, { error: where.error }, where.status);
  if (mode === "raw") return sendRawImage(res, where.read);
  const preview = await previewJson(where.read, requested!, where.host);
  json(res, preview.body, preview.status);
}

/**
 * The per-session file routes, in one place so api.ts carries a single line:
 *
 * POST /api/sessions/:id/attachments — a running agent pushes a file or image
 * into the chat. Multipart (file + optional text/caption) or JSON
 * ({path|content|url, filename?, text?}); stored under uploads/<date>/<sessionId>/
 * and surfaced as an assistant message with rendered media. Only the path/URL
 * reaches the UI, never raw bytes in the prompt.
 *
 * GET /api/sessions/:id/files/{read,raw}?path= — see {@link handleSessionFileRead}.
 *
 * Returns true when the request was one of these.
 */
export async function handleSessionFileRoutes(
  req: HttpRequest,
  res: ServerResponse,
  { method, pathname, url }: ParsedRoute,
  caller: () => CallerIdentity,
  context: ApiContext,
): Promise<boolean> {
  const attachment = matchRoute("/api/sessions/:id/attachments", pathname);
  if (method === "POST" && attachment) {
    if (!getSession(attachment.id)) notFound(res);
    else await handleSessionAttachment(req, res, attachment.id, context);
    return true;
  }
  const read = matchRoute("/api/sessions/:id/files/:mode", pathname);
  if (method !== "GET" || (read?.mode !== "read" && read?.mode !== "raw")) return false;
  await handleSessionFileRead(res, { sessionId: read.id, mode: read.mode, url, caller: caller() }, context);
  return true;
}
