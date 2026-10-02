import path from "node:path";
import type { RemoteTarget } from "../shared/types.js";
import type { RemoteEngineName } from "../shared/models.js";
import { sshDestination } from "../shared/remote-target.js";
import { gatherFacts, remoteSessionHome, shq, sshRun, SSH_CONNECTION_FAILED, type RemoteFacts } from "./remote-stage.js";

/**
 * Read one file a remote session can see, on the host it runs on.
 *
 * A remote employee's files live on its build host, not on the gateway, so a
 * path it names in chat means nothing to the gateway's own filesystem. The
 * gateway asks that host instead, over the same key-only ssh control channel it
 * already uses to stage sessions.
 *
 * The standing file-read policy is applied ON the remote host, by the remote's
 * own jinn-cli install (whose version {@link gatherFacts} has already pinned to
 * ours): `vetLocalFileForIngestion` / `readLocalFileForIngestion` from
 * `shared/file-read-policy.js`, with the session's stage dir as its home. That
 * is the same function, judged against the same filesystem, that the remote
 * MCP server uses when a session uploads a file of its own — so the gateway's
 * mount, every session stage, `.ssh/`, `.env*` and key files are refused there
 * exactly as they are locally. A policy re-implemented here in shell would be a
 * second policy, and the two would drift.
 *
 * Only existing exports of the remote install are used, so a host does not need
 * an upgrade to serve reads.
 */

export type RemoteFileOp = "vet" | "read";

export type RemoteFileResult =
  | { ok: true; realPath: string; size: number; buffer?: Buffer }
  | { ok: false; status: number; error: string };

/** Runs on the remote host under `node --input-type=module -`, args after it.
 *  Writes exactly one JSON line. Exported for tests, which run it locally
 *  against this build's own policy module. */
export const REMOTE_FILE_READ_SCRIPT = `
import path from "node:path";
import { pathToFileURL } from "node:url";
const [, , policyPath, op, requested, cwd, maxBytesRaw, jinnHome] = process.argv;
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
try {
  const policy = await import(pathToFileURL(policyPath).href);
  const expanded = policy.expandPath(requested);
  const target = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  const maxBytes = Number(maxBytesRaw);
  if (op === "vet") {
    const vetted = policy.vetLocalFileForIngestion(target, maxBytes, { jinnHome });
    out(vetted.ok ? { ok: true, realPath: vetted.realPath, size: vetted.size } : vetted);
  } else {
    const read = policy.readLocalFileForIngestion(target, maxBytes, { jinnHome });
    out(read.ok ? { ok: true, realPath: read.realPath, size: read.buffer.length, data: read.buffer.toString("base64") } : read);
  }
} catch (err) {
  out({ ok: false, status: 500, error: err instanceof Error ? err.message : String(err) });
}
`;

/** The policy module inside the remote install. `entryDir` is that install's
 *  `dist/src/mcp`, so the policy sits beside it under `shared/`. */
export function remotePolicyModule(facts: RemoteFacts): string {
  return path.posix.join(facts.entryDir, "..", "shared", "file-read-policy.js");
}

export interface RemoteFileReadOpts {
  target: RemoteTarget & { remoteHost: string };
  sessionId: string;
  engine: RemoteEngineName;
  /** As the session wrote it: absolute, `~/`, or relative to `remoteCwd`. */
  requestedPath: string;
  op: RemoteFileOp;
  maxBytes: number;
}

/** Shape the remote's JSON answer; anything else is the host misbehaving. */
export function parseRemoteFileAnswer(stdout: string, destination: string): RemoteFileResult {
  const line = stdout.trim().split("\n").pop() ?? "";
  let parsed: { ok?: unknown; realPath?: unknown; size?: unknown; data?: unknown; status?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, status: 502, error: `${destination} returned an unreadable answer` };
  }
  if (parsed.ok === true && typeof parsed.realPath === "string" && typeof parsed.size === "number") {
    const buffer = typeof parsed.data === "string" ? Buffer.from(parsed.data, "base64") : undefined;
    return { ok: true, realPath: parsed.realPath, size: parsed.size, ...(buffer ? { buffer } : {}) };
  }
  const status = typeof parsed.status === "number" ? parsed.status : 502;
  return { ok: false, status, error: typeof parsed.error === "string" ? parsed.error : `${destination} refused the read` };
}

export async function readRemoteSessionFile(opts: RemoteFileReadOpts): Promise<RemoteFileResult> {
  const destination = sshDestination(opts.target);
  let facts: RemoteFacts;
  try {
    // Cached after the first spawn on this host. Never wakes it: opening a file
    // link must not boot someone's desktop.
    facts = await gatherFacts(destination);
  } catch (err) {
    return { ok: false, status: 502, error: `${destination} is not available: ${err instanceof Error ? err.message : String(err)}` };
  }
  const args = [
    remotePolicyModule(facts),
    opts.op,
    opts.requestedPath,
    opts.target.remoteCwd ?? facts.home,
    String(opts.maxBytes),
    remoteSessionHome(facts, opts.sessionId, opts.engine),
  ];
  const command = [shq(facts.nodeBin), "--input-type=module", "-", ...args.map(shq)].join(" ");
  const res = await sshRun(destination, [command], { stdin: REMOTE_FILE_READ_SCRIPT });
  if (res.code === SSH_CONNECTION_FAILED || res.code === null) {
    return { ok: false, status: 502, error: `could not reach ${destination}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}` };
  }
  return parseRemoteFileAnswer(res.stdout, destination);
}
