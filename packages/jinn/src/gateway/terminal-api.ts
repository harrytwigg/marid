import type { IncomingMessage, ServerResponse } from "node:http";
import { createSession } from "../sessions/registry.js";
import type { Employee, JinnConfig, Session } from "../shared/types.js";
import { findTerminalHost, listTerminalHosts, type TerminalHostList } from "../terminals/hosts.js";
import { TERMINAL_SESSION_ENGINE, TERMINAL_SESSION_SOURCE } from "../terminals/session.js";
import { readJsonBody } from "./http-helpers.js";
import { json, type ParsedRoute } from "./route-helpers.js";

export interface TerminalApiOptions {
  getConfig: () => JinnConfig;
  employees: () => Iterable<Employee>;
  /** True only for the operator: a shell is never handed to an agent session. */
  isOperator: () => boolean;
  serialize: (session: Session) => unknown;
  onCreated: (session: Session) => void;
}

const OPERATOR_ONLY = "Terminals are operator-only; an agent session cannot open a shell.";

export function terminalHostsFor(options: Pick<TerminalApiOptions, "getConfig" | "employees">): TerminalHostList {
  return listTerminalHosts(options.getConfig(), options.employees());
}

/**
 * `GET /api/terminals/hosts` — the machines a terminal can open on.
 * `POST /api/terminals { hostId }` — create a terminal session on one; its shell
 * starts when the web view attaches to `/ws/pty/:id`.
 */
export async function handleTerminalApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: ParsedRoute,
  options: TerminalApiOptions,
): Promise<boolean> {
  const { method, pathname } = route;
  if (pathname !== "/api/terminals/hosts" && pathname !== "/api/terminals") return false;
  if (!options.isOperator()) return refuse(res, 403, OPERATOR_ONLY);
  if (method === "GET" && pathname === "/api/terminals/hosts") {
    json(res, terminalHostsFor(options));
    return true;
  }
  if (method === "POST" && pathname === "/api/terminals") return createTerminal(req, res, options);
  return refuse(res, 405, "Method not allowed");
}

async function createTerminal(req: IncomingMessage, res: ServerResponse, options: TerminalApiOptions): Promise<true> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return true;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  const list = terminalHostsFor(options);
  if (!list.enabled) return refuse(res, 409, list.disabledReason ?? "Terminals are off.");
  const host = findTerminalHost(list, typeof body.hostId === "string" ? body.hostId : undefined);
  if (!host) return refuse(res, 404, `Unknown terminal host "${String(body.hostId ?? "")}"`);
  const session = createSession({
    engine: TERMINAL_SESSION_ENGINE,
    source: TERMINAL_SESSION_SOURCE,
    sourceRef: host.id,
    // Unique per terminal: the queue and callback machinery key on it.
    sessionKey: `terminal:${host.id}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    employee: null,
    title: host.label,
  });
  options.onCreated(session);
  json(res, options.serialize(session), 201);
  return true;
}

function refuse(res: ServerResponse, status: number, error: string): true {
  json(res, { error }, status);
  return true;
}
