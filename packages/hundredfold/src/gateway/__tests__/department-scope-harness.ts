import fs from "node:fs";
import path from "node:path";
import { call, context, home, startRouteHarness } from "./todo-route-harness.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

/**
 * The scoped-caller fixture: a real home with two scoped departments and an open one,
 * driven through the real `handleApiRequest` as capability-bound sessions. All names
 * are invented.
 *
 *   side-project (scoped):     side-dev, side-qa
 *   other-side   (dedicated):  other-dev
 *   engineering  (open):       eng-dev, and the harness's own route-worker at the org root
 *
 * Import this before anything that reads the home (it imports todo-route-harness first).
 */

export { call, context, home };

function write(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function employee(directory: string, name: string, engine = "claude"): void {
  write(path.join(home, "org", directory, `${name}.yaml`), [
    `name: ${name}`, `displayName: ${name}`, `department: ${directory}`, "rank: employee", `engine: ${engine}`, "model: opus", `persona: Works on ${directory}.`,
  ]);
}

export function writeScopedOrg(): void {
  write(path.join(home, "org", "side-project", "department.yaml"), ["name: side-project", "scope: scoped", "skills: [dev-workflow]"]);
  write(path.join(home, "org", "other-side", "department.yaml"), ["name: other-side", "scope: dedicated"]);
  employee("side-project", "side-dev");
  employee("side-project", "side-qa");
  employee("other-side", "other-dev");
  employee("engineering", "eng-dev");
}

export async function startScopedHarness() {
  const modules = await startRouteHarness();
  writeScopedOrg();
  const { refreshOrg } = await import("../org-registry.js");
  refreshOrg(context.getConfig());
  return modules;
}

export function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

/** A capability-bound session of `employee`, as any spawn path would create it. */
export async function sessionOf(employee: string | null, extra: { parentSessionId?: string } = {}) {
  const { createSession } = await import("../../sessions/registry.js");
  return createSession({ engine: "claude", source: "web", sourceRef: `web:${employee}:${Math.random()}`, employee, ...extra });
}

/** Call the API as `session`. */
export function as(sessionId: string) {
  return (method: string, url: string, body?: unknown) => call(method, url, body, sessionHeaders(sessionId));
}

/** Call the API with a raw body and exactly these headers (plus host and the bearer), for malformed-input cases. */
export async function callRaw(method: string, url: string, raw: string, headers: Record<string, string | undefined>) {
  const { Readable } = await import("node:stream");
  const api = await import("../api.js");
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  };
  const defined = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)) as Record<string, string>;
  const request = Object.assign(Readable.from([Buffer.from(raw)]), { method, url, headers: { host: "localhost", authorization: "Bearer test-token", ...defined } });
  await api.handleApiRequest(request as never, res as never, context);
  const text = Buffer.concat(chunks).toString("utf-8");
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status, body };
}
