import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { json, matchRoute, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";
import { readJsonBody } from "./http-helpers.js";
import { getRun, lastRunOf, listRuns, RUN_PAGE_MAX, type RunFilter } from "../board-hooks/run-store.js";
import type { HookRunStatus } from "../board-hooks/types.js";
import { hookEvents, hooksProblems, runnableHooks, type BoardHookConfig } from "../shared/board-hooks-config.js";
import { patchConfigFile } from "../shared/config-document.js";
import { CONFIG_PATH } from "../shared/paths.js";

/**
 * Board hooks (docs/board-hooks.md). All four routes are operator-only through
 * `OPERATOR_ONLY_ROUTES` (control-plane-routes.ts), which api.ts applies before
 * this module is reached.
 *
 *   GET  /api/hooks                  the configured hooks, with their last run, and config problems
 *   GET  /api/hooks/runs             the run log, newest first (hook, status, todo, limit, before)
 *   GET  /api/hooks/runs/:id         one run, with its payload and output
 *   POST /api/hooks/:name/enabled    toggle `enabled` in config.yaml, in place, and reload
 */

const RUN_STATUSES: readonly string[] = ["running", "ok", "error", "suppressed", "interrupted"];

function summariseActions(hook: BoardHookConfig): unknown[] {
  const { spawn, command, notify } = hook.action;
  return [
    ...(spawn ? [{ kind: "spawn", employee: spawn.employee }] : []),
    ...(command ? [{ kind: "command", run: command.run }] : []),
    ...(notify ? [{ kind: "notify", connector: notify.connector, channel: String(notify.channel) }] : []),
  ];
}

function describeHook(hook: BoardHookConfig): Record<string, unknown> {
  const last = lastRunOf(hook.name);
  return {
    name: hook.name,
    enabled: hook.enabled !== false,
    events: hookEvents(hook),
    match: hook.match ?? {},
    actions: summariseActions(hook),
    allowReentry: hook.allowReentry === true,
    lastFiredAt: last?.startedAt ?? null,
    lastStatus: last?.status ?? null,
  };
}

function numberParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, RUN_PAGE_MAX) : undefined;
}

/** The run-list filter from the query string, or the reason it cannot be one. */
function runFilter(url: URL): { ok: true; filter: RunFilter } | { ok: false; error: string } {
  const status = url.searchParams.get("status") || undefined;
  if (status !== undefined && !RUN_STATUSES.includes(status)) return { ok: false, error: `status must be one of ${RUN_STATUSES.join(", ")}` };
  const text = (key: string) => url.searchParams.get(key) || undefined;
  return {
    ok: true,
    filter: {
      hook: text("hook"), status: status as HookRunStatus | undefined, todo: text("todo"),
      before: text("before"), limit: numberParam(url, "limit"),
    },
  };
}

async function handleToggle(req: HttpRequest, res: ServerResponse, name: string, context: ApiContext): Promise<void> {
  const found = runnableHooks(context.getConfig()).find(({ hook }) => hook.name === name);
  if (!found) return json(res, { error: `no hook named "${name}"` }, 404);
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const enabled = (parsed.body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") return json(res, { error: "enabled must be true or false" }, 400);
  patchConfigFile(CONFIG_PATH, [{ path: ["hooks", found.index, "enabled"], value: enabled }]);
  context.reloadConfig?.();
  json(res, { ok: true });
}

function handleRunDetail(res: ServerResponse, id: string): void {
  const run = getRun(id);
  if (!run) return json(res, { error: `no hook run "${id}"` }, 404);
  json(res, { run });
}

function handleList(res: ServerResponse, context: ApiContext): void {
  const config = context.getConfig();
  json(res, { hooks: runnableHooks(config).map(({ hook }) => describeHook(hook)), problems: hooksProblems(config.hooks) });
}

function handleRuns(res: ServerResponse, url: URL): void {
  const parsed = runFilter(url);
  if (parsed.ok) json(res, listRuns(parsed.filter));
  else json(res, { error: parsed.error }, 400);
}

export async function handleBoardHooksApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  const { method, pathname, url } = route;
  if (!pathname.startsWith("/api/hooks")) return false;
  if (method === "GET" && pathname === "/api/hooks") return (handleList(res, context), true);
  if (method === "GET" && pathname === "/api/hooks/runs") return (handleRuns(res, url), true);
  const detail = matchRoute("/api/hooks/runs/:id", pathname);
  if (method === "GET" && detail) return (handleRunDetail(res, detail.id), true);
  const toggle = matchRoute("/api/hooks/:name/enabled", pathname);
  if (method !== "POST" || !toggle) return false;
  await handleToggle(req, res, toggle.name, context);
  return true;
}
