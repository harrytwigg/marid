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
