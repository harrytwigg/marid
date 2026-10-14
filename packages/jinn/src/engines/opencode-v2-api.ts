import { record, str, type V2Message } from "./opencode-v2-events.js";
import { jinnSessionNotes, withJinnSessionNotes, type JinnSessionNotes } from "./opencode-v2-history.js";

/**
 * The OpenCode 2 server API (`/api/*`) as Jinn uses it. Verified on 2.0.29.
 *
 * The same server process, password and ssh forward as 1.x (`opencode serve
 * --port N --hostname 127.0.0.1`, HTTP basic auth as `opencode` with
 * `OPENCODE_SERVER_PASSWORD`); only the routes and shapes differ. Every JSON
 * answer wraps its payload in `{data}`.
 */

export const V2_REQUEST_TIMEOUT_MS = 30_000;

/** Enough of a server to call it. */
export interface V2Endpoint {
  apiUrl: string;
  password: string;
}

function authHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

export function v2Headers(password: string, json = false): Record<string, string> {
  return { authorization: authHeader(password), ...(json ? { "content-type": "application/json" } : {}) };
}

/** A 404 for a session the server does not have. */
export class V2NotFoundError extends Error {}

/** One request; the parsed answer (its `data`, when it has one). */
export async function v2Request(
  server: V2Endpoint,
  method: "GET" | "POST" | "DELETE" | "PATCH",
  route: string,
  body?: unknown,
  signal: AbortSignal = AbortSignal.timeout(V2_REQUEST_TIMEOUT_MS),
): Promise<unknown> {
  const res = await fetch(`${server.apiUrl}${route}`, {
    method,
    headers: v2Headers(server.password, body !== undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const message = `${method} ${route} answered ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`;
    throw res.status === 404 ? new V2NotFoundError(message) : new Error(message);
  }
  if (!text) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text; }
  const wrapped = record(parsed);
  return wrapped && "data" in wrapped ? wrapped.data : parsed;
}

export function sessionRoute(engineSessionId: string, rest = ""): string {
  return `/api/session/${encodeURIComponent(engineSessionId)}${rest}`;
}

/** The sessions the server is running an execution in. */
export async function v2RunningSessions(server: V2Endpoint): Promise<string[]> {
  const active = record(await v2Request(server, "GET", "/api/session/active")) ?? {};
  return Object.entries(active).filter(([, v]) => str(record(v)?.type) === "running").map(([id]) => id);
}

/** The session's newest messages, newest first. */
export async function v2Messages(server: V2Endpoint, engineSessionId: string, limit: number): Promise<V2Message[]> {
  const body = await v2Request(server, "GET", sessionRoute(engineSessionId, `/message?limit=${limit}&order=desc`));
  return Array.isArray(body) ? body.map(record).filter((m): m is V2Message => Boolean(m)) : [];
}

/** Whether an item is still waiting in the session's inbox (not delivered). */
export async function v2InInbox(server: V2Endpoint, engineSessionId: string, inboxId: string): Promise<boolean> {
  const inbox = await v2Request(server, "GET", sessionRoute(engineSessionId, "/inbox"));
  return Array.isArray(inbox) && inbox.some((item) => str(record(item)?.id) === inboxId);
}

/** Take an undelivered item back out of the inbox; false when it had already
 *  been delivered (or was never there). */
export async function v2CancelInbox(server: V2Endpoint, engineSessionId: string, inboxId: string): Promise<boolean> {
  if (!(await v2InInbox(server, engineSessionId, inboxId))) return false;
  try {
    await v2Request(server, "DELETE", sessionRoute(engineSessionId, `/inbox/${encodeURIComponent(inboxId)}`));
    return true;
  } catch {
    // Delivered between the read and the delete.
    return false;
  }
}

export async function v2Interrupt(server: V2Endpoint, engineSessionId: string): Promise<void> {
  await v2Request(server, "POST", sessionRoute(engineSessionId, "/interrupt"));
}

/** Post a prompt as the operator would type it (the terminal view's composer). */
export async function v2Prompt(server: V2Endpoint, engineSessionId: string, text: string): Promise<void> {
  await v2Request(server, "POST", sessionRoute(engineSessionId, "/prompt"), { text, delivery: "queue" });
}

export interface V2AbortTiming {
  settleMs: number;
  confirmMs: number;
  pollMs: number;
}

/**
 * Stop one turn on a 2.x server and wait until it is certainly stopped.
 *
 * A prompt still waiting in the inbox (queued behind something else the
 * session runs) is simply taken back out: interrupting then would stop the
 * operator's execution, not the turn's. A delivered one is interrupted, and
 * interrupted again for as long as the session runs, until it has stayed idle
 * for the confirmation window: an interrupt that lands before opencode has
 * started the execution answers `interrupted: false`, and the prompt then runs.
 * Throws when the session is still running at the bound.
 */
export async function v2AbortTurn(
  server: V2Endpoint,
  target: { engineSessionId: string; userMessageId: string },
  timing: V2AbortTiming,
): Promise<void> {
  if (await v2CancelInbox(server, target.engineSessionId, target.userMessageId)) return;
  await v2Interrupt(server, target.engineSessionId);
  const deadline = Date.now() + timing.settleMs;
  let quietSince = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
    if ((await v2RunningSessions(server)).includes(target.engineSessionId)) {
      quietSince = 0;
      await v2Interrupt(server, target.engineSessionId);
    } else if (!quietSince) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= timing.confirmMs) {
      return;
    }
    if (Date.now() > deadline) throw new Error("the turn was still running after repeated interrupts");
  }
}

/**
 * Wait until the server has finished connecting the named MCP servers.
 * OpenCode 2 loads MCP servers lazily, per directory, on the first request
 * that asks about them: `GET /api/mcp` answers `[]` first, then `pending`,
 * then `connected` (2.0.29, about a second for a stdio server). A prompt sent
 * before that runs without their tools, so a server is not handed to a turn
 * until each one has connected, or failed, or the bound has passed. Returns
 * the servers that did not connect.
 */
export async function v2WaitMcpReady(server: V2Endpoint, names: string[], timeoutMs: number, pollMs = 200): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let notConnected = names;
  for (;;) {
    const listed = await v2Request(server, "GET", "/api/mcp").catch(() => []);
    const status = new Map((Array.isArray(listed) ? listed : []).map((m) => [str(record(m)?.name), str(record(record(m)?.status)?.status)]));
    notConnected = names.filter((name) => status.get(name) !== "connected");
    const settled = names.every((name) => status.has(name) && status.get(name) !== "pending");
    if (settled || Date.now() > deadline) return notConnected;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Change the notes Jinn keeps on a session (see opencode-v2-history.ts):
 *  read its metadata, apply `change`, write the whole of it back. */
export async function v2UpdateSessionNotes(
  server: V2Endpoint,
  engineSessionId: string,
  change: (notes: JinnSessionNotes) => JinnSessionNotes,
): Promise<void> {
  const session = record(await v2Request(server, "GET", sessionRoute(engineSessionId)));
  const metadata = record(session?.metadata);
  const metadataNext = withJinnSessionNotes(metadata, change(jinnSessionNotes(metadata)));
  await v2Request(server, "PATCH", sessionRoute(engineSessionId), { metadata: metadataNext });
}
