import fs from "node:fs";
import path from "node:path";
import { GATEWAY_TIMEOUT_MS, gatewayRequest, JinnMcpToolError, type JinnMcpContext } from "./toolkit.js";
import { expandPath, readLocalFileForIngestion, vetLocalFileForIngestion } from "../shared/file-read-policy.js";
import { resolveJinnHome } from "../shared/home.js";
import { gatewayFailure } from "./work-item-result.js";
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_SUBDIR, attachmentRelativePath } from "../work-items/attachment-layout.js";

/**
 * Host-agnostic Todo attachments for the MCP surface.
 *
 * The gateway route can read a named path on ITS filesystem, which is only the
 * session's filesystem when the session runs on the gateway host. A session on
 * a remote build host names a file on its own disk, so:
 *
 * UPLOAD — the file is always read HERE, on the host the session runs on, under
 * the same file-read policy, symlink discipline and 25 MB cap the gateway
 * applies, and its bytes go to the route's multipart branch. There is no
 * fallback to the gateway's JSON `{ path }` mode: absence here is not evidence
 * of presence there, and on a remote host a same-named gateway file is a
 * different file (a stale report attached as fresh evidence). On the gateway
 * host the two filesystems are one, so the fallback would buy nothing. The path
 * must be absolute (or `~/`, this host's home). A relative one is refused: the
 * agent's shell may have changed directory since this server started, and any
 * other anchor (the instance home) would silently resolve a repo's `docs/x.md`
 * to Jinn's own copy — the same wrong-file failure. The route's JSON mode stays
 * for other HTTP callers.
 *
 * READ — each listed row keeps the gateway's `storagePath` and gains
 * `localPath` (this host's view of the same bytes through the instance home,
 * size-checked; null where there is none) and `downloadUrl` (the byte route,
 * reachable from this host with the gateway bearer token). A caller with no
 * host of its own (the remote connector, `ctx.hostLocations === false`) gets
 * metadata only.
 */

/** Upload budget: the standard budget plus 2 s per MiB, so a 25 MB file over a
 *  slow tunnel is not cut off by the budget sized for millisecond JSON routes. */
function uploadTimeoutMs(ctx: JinnMcpContext, bytes: number): number {
  return ctx.timeoutMs ?? GATEWAY_TIMEOUT_MS + Math.ceil(bytes / (1024 * 1024)) * 2_000;
}

/** The path as this host opens it. Relative paths are refused (see above). */
function sessionHostPath(requested: string): string {
  const expanded = expandPath(requested);
  if (!path.isAbsolute(expanded)) {
    throw new JinnMcpToolError(
      `cannot attach "${requested}": pass an absolute path (or ~/…) — attachments are read on the host this session runs on, and a relative path has no reliable anchor there`,
    );
  }
  return path.resolve(expanded);
}

function refusal(requested: string, resolved: string, error: string, status: number): JinnMcpToolError {
  const where = resolved === requested ? "" : ` (${resolved})`;
  const code = status === 413 ? " (attachment_too_large)" : "";
  const help = status === 404 ? " — attachments are read on the host this session runs on" : "";
  return new JinnMcpToolError(`cannot attach "${requested}"${where}: ${error}${code}${help}`);
}

/**
 * Check a file is attachable without reading it: present on this host, allowed
 * by the file-read policy, non-empty, within the cap. Throws the refusal. Lets
 * a caller vet every file before an irreversible step (posting a comment).
 */
function vetWorkItemAttachment(requestedPath: string): void {
  const resolved = sessionHostPath(requestedPath);
  const vetted = vetLocalFileForIngestion(resolved, ATTACHMENT_MAX_BYTES);
  if (!vetted.ok) throw refusal(requestedPath, resolved, vetted.error, vetted.status);
  if (vetted.size === 0) throw refusal(requestedPath, resolved, "attachment must not be empty", 400);
}

/** Vet a new comment's files before the comment is posted. A caller with no
 *  host of its own (the remote connector) cannot upload at all — its door does
 *  not reach the attachment route — so it is refused before anything exists,
 *  rather than leaving a comment without its evidence. */
export function vetCommentAttachments(ctx: JinnMcpContext, paths: readonly string[]): void {
  if (paths.length > 0 && ctx.hostLocations === false) {
    throw new JinnMcpToolError(NO_HOST_REFUSAL);
  }
  paths.forEach(vetWorkItemAttachment);
}

export interface AttachmentUploadTarget {
  commentId?: string;
  filename?: string;
}

/** Transport codes from before any byte was sent (see gatewayRequest). */
const CONNECT_PHASE_FAILURE = /\((?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\)/;

/** The bare cause from a gatewayRequest transport error, without its own
 *  "retry" advice — which is exactly wrong when the upload may have landed. */
function transportCause(message: string): string {
  return /timed out after \d+ms/.exec(message)?.[0] ?? /failed before a response: (.+?) —/.exec(message)?.[1] ?? "no response";
}

const NO_HOST_REFUSAL = "attachments cannot be uploaded over this connector: it has no host of its own to read files from";

/** Upload one file from this session's host to a Todo (or one of its
 *  comments). Local refusals throw; the gateway's answer is returned raw so the
 *  caller owns its error wording. */
export async function uploadWorkItemAttachment(
  ctx: JinnMcpContext,
  workItemId: string,
  requestedPath: string,
  target: AttachmentUploadTarget = {},
): Promise<{ status: number; body: unknown }> {
  // A caller with no host of its own has nothing to read here (the remote door).
  if (ctx.hostLocations === false) throw new JinnMcpToolError(NO_HOST_REFUSAL);
  const resolved = sessionHostPath(requestedPath);
  const read = readLocalFileForIngestion(resolved, ATTACHMENT_MAX_BYTES);
  if (!read.ok) throw refusal(requestedPath, resolved, read.error, read.status);
  if (read.buffer.length === 0) throw refusal(requestedPath, resolved, "attachment must not be empty", 400);
  const filename = target.filename ?? path.basename(read.realPath);
  const form = new FormData();
  if (target.commentId !== undefined) form.append("commentId", target.commentId);
  // The filename also travels as a plain field: the part header's filename is
  // percent-escaped by fetch for `"` and newlines, and busboy does not undo it.
  form.append("filename", filename);
  form.append("file", new Blob([read.buffer]), filename);
  const route = `/api/work-items/${encodeURIComponent(workItemId)}/attachments`;
  try {
    return await gatewayRequest({ ...ctx, timeoutMs: uploadTimeoutMs(ctx, read.buffer.length) }, "POST", route, form);
  } catch (err) {
    // Only a connection that never opened proves nothing landed. A timeout or a
    // socket dropped after the body went out may have been stored, and a blind
    // retry would add a second row.
    if (!(err instanceof JinnMcpToolError) || CONNECT_PHASE_FAILURE.test(err.message)) throw err;
    throw new JinnMcpToolError(
      `uploading "${requestedPath}" got no answer from the gateway (${transportCause(err.message)}); it may still have landed — check list_work_item_attachments { id: "${workItemId}" } before retrying`,
    );
  }
}

/** Upload a new comment's files in order. The comment already exists, so every
 *  failure — a local refusal (the file changed since it was vetted) or the
 *  gateway's — says so, and how far it got, rather than inviting a retry that
 *  would post the comment twice. */
export async function uploadCommentAttachments(
  ctx: JinnMcpContext,
  workItemId: string,
  commentId: string,
  paths: readonly string[],
): Promise<unknown[]> {
  const uploaded: unknown[] = [];
  for (const filePath of paths) {
    const what = `comment ${commentId} was created, but attaching "${filePath}" (${uploaded.length}/${paths.length} uploaded)`;
    let attach: { status: number; body: unknown };
    try {
      attach = await uploadWorkItemAttachment(ctx, workItemId, filePath, { commentId });
    } catch (err) {
      if (err instanceof JinnMcpToolError) throw new JinnMcpToolError(`${what} failed: ${err.message} — do not re-post the comment`);
      throw err;
    }
    if (attach.status >= 400) throw gatewayFailure(what, attach.status, attach.body);
    uploaded.push((attach.body as { attachment?: unknown } | null)?.attachment ?? attach.body);
  }
  return uploaded;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** This host's path to an attachment's bytes, when the instance home here
 *  reaches the gateway's attachment store (the gateway itself, or a remote
 *  staging home whose `attachments` links into the mount) and the file there
 *  has the recorded size — the same cheap guard the download route uses. */
function hostMappedPath(row: Record<string, unknown>): string | null {
  const sha = row.sha256;
  if (typeof sha !== "string" || !SHA256_PATTERN.test(sha)) return null;
  const candidate = path.join(resolveJinnHome(), ATTACHMENTS_SUBDIR, attachmentRelativePath(sha));
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() && stat.size === row.bytes ? candidate : null;
  } catch {
    return null;
  }
}

/** Decorate a list response's rows with `localPath` + `downloadUrl`. */
export function withReadableLocations(ctx: JinnMcpContext, workItemId: string, body: unknown): unknown {
  if (!body || typeof body !== "object" || !Array.isArray((body as { attachments?: unknown }).attachments)) return body;
  const rows = (body as { attachments: unknown[] }).attachments;
  if (ctx.hostLocations === false) {
    // storagePath too: it is the gateway's disk (and its username), not a place.
    const metadata = rows.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const { storagePath: _storagePath, ...rest } = entry as Record<string, unknown>;
      return rest;
    });
    return { ...(body as Record<string, unknown>), attachments: metadata };
  }
  const base = ctx.gatewayUrl.replace(/\/+$/, "");
  const attachments = rows.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const row = entry as Record<string, unknown>;
    const downloadUrl = typeof row.id === "string"
      ? `${base}/api/work-items/${encodeURIComponent(workItemId)}/attachments/${encodeURIComponent(row.id)}?download=1`
      : null;
    return { ...row, localPath: hostMappedPath(row), downloadUrl };
  });
  return {
    ...(body as Record<string, unknown>),
    attachments,
    hint: "Read localPath on this host. If null, GET downloadUrl with header 'Authorization: Bearer $JINN_GATEWAY_TOKEN'. storagePath is the gateway's own path.",
  };
}
