import fs from "node:fs";
import path from "node:path";
import type { McpServerStdioConfig, McpServerUrlConfig, ResolvedMcpConfig } from "../shared/types.js";
import { MCP_TOOLSET_ARG } from "../mcp/identity.js";
import { buildBoardWalkTools } from "../mcp/board-walk-tools.js";
import { HUNDREDFOLD_HOME } from "../shared/paths.js";
import { findBuiltinMcp } from "../mcp/builtin-name.js";
import { NAMES } from "../shared/codename.js";
import type { OpencodeApi } from "./opencode-version.js";
import type { OpencodeProviderBlock } from "../shared/opencode-accounts.js";
import type { OpencodeAccountStaging } from "./opencode-accounts.js";

/**
 * The company toolset, as opencode takes it.
 *
 * opencode reads a real MCP config, which makes this the cheapest wiring of any
 * engine here: no generated extension module (pi), no `--mcp-config` dialect of
 * its own (claude) — just hundredfold's already-resolved server set projected into
 * opencode's `mcp` block and handed over through `OPENCODE_CONFIG`.
 *
 * `OPENCODE_CONFIG` MERGES with the operator's own config rather than replacing
 * it (verified against opencode 1.16.2), so this file carries only what hundredfold has
 * to add. For an ordinary session it does NOT carry a `permission` block:
 * forcing `allow` would quietly override an operator who deliberately denied
 * `bash` on that machine. Unattended approval comes from
 * `--dangerously-skip-permissions`, which auto-approves everything NOT
 * explicitly denied — the operator's deny still wins, exactly as it does when
 * they run opencode themselves.
 *
 * A purpose-built toolset session (the board walk's turn) is the exception. Its
 * whole point is that its tools are the only ones it has, and opencode — unlike
 * Claude — has no command-line switch to turn its built-ins off. So this file
 * adds a `hundredfold-walk` agent that allows exactly the toolset's own tools and
 * denies everything else (`permission` default deny, one allow per name), and
 * the turn selects it with `--agent hundredfold-walk`. Two things make the allowlist
 * exact rather than a `hundredfold_*` wildcard:
 *
 *   - the toolset server is named `hundredfold`, so its tools surface as
 *     `hundredfold_walk_board` … `hundredfold_walk_finish` — generated here from the toolset
 *     itself, so the two cannot drift;
 *   - `hundredfold_*` would also match any OTHER server whose name starts with `hundredfold`
 *     (the operator's own, say), and a project `opencode.json` in the turn's cwd
 *     loads after this staged file and can replace `mcp.hundredfold` outright. Naming
 *     each tool closes both routes.
 *
 * An agent's permissions beat the operator's own (verified with
 * `opencode debug agent`), and the clamp only ever denies, never allows, so it
 * cannot widen a surface the operator narrowed.
 *
 * OpenCode 2 takes the same file in its own shape (`mcp.servers`, `agents` with
 * `permissions` rules), and needs it: a 1.x-shaped file still loads, but 2.x
 * then offers MCP tools only through its "Code Mode" (one `execute` tool), so
 * the model never sees `hundredfold_*` tools and the walk agent's deny-all leaves it
 * none. `codemode: false` on each server keeps them as tools, and only the
 * native shape carries it (verified on 2.0.29). Which shape a session gets
 * follows the binary's version.
 */

/** The opencode agent a purpose-built toolset session runs as: the toolset's
 *  own tools allowed and every other denied. The name the board walk's turn
 *  passes to `--agent` (board-walk/route-turn.ts). */
export const OPENCODE_WALK_AGENT = "hundredfold-walk";

/** The opencode tool names the board-walk toolset exposes: the built-in server's
 *  registered name joined to each tool the toolset serves. Read from the toolset, never
 *  hand-typed, so a new walk tool joins the allowlist on its own. */
export function boardWalkOpencodeTools(serverName: string = NAMES.codename): string[] {
  return buildBoardWalkTools().map((tool) => `${serverName}_${tool.name}`);
}

/** The confined agent's permission map: deny by default, then allow each of the
 *  board-walk toolset's own tool names exactly. */
export function boardWalkAgentPermission(serverName: string = NAMES.codename): Record<string, string> {
  const permission: Record<string, string> = { "*": "deny" };
  for (const name of boardWalkOpencodeTools(serverName)) permission[name] = "allow";
  return permission;
}

/** A stdio server, as opencode's config names it: one argv array where hundredfold's
 *  resolved shape has `command` + `args`, and `environment` where hundredfold has `env`. */
export interface OpencodeLocalMcpServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
}

/** A URL-backed server. hundredfold's resolver emits these for SSE endpoints; opencode
 *  calls the same thing `remote`. */
export interface OpencodeRemoteMcpServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  enabled: true;
}

export type OpencodeMcpServer = OpencodeLocalMcpServer | OpencodeRemoteMcpServer;

/** The config file hundredfold stages for one session. Only the keys hundredfold forces. */
export interface OpencodeSessionConfig {
  $schema: string;
  mcp: Record<string, OpencodeMcpServer>;
  /** Plugins Hundredfold adds to the operator's own (opencode-command-timeout.ts). */
  plugin?: string[];
  /** Only for a purpose-built toolset session: the confined agent below. */
  agent?: Record<string, OpencodeConfinedAgent>;
  /** One block per declared opencode account that has a base (opencode-accounts.ts). */
  provider?: Record<string, OpencodeProviderBlock>;
}

/** The confined agent an opencode toolset session runs as. */
export interface OpencodeConfinedAgent {
  mode: "primary";
  permission: Record<string, string>;
}

export type OpencodeConfigHandle =
  | { staged: false }
  | { staged: true; configPath: string; configDir: string; released?: boolean };

const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** A stdio server as opencode takes it, or null when the spec is not one. */
function projectStdioServer(spec: Record<string, unknown>): OpencodeLocalMcpServer | null {
  const stdio = spec as unknown as McpServerStdioConfig;
  if (typeof stdio.command !== "string" || !stdio.command) return null;
  const environment = stdio.env && Object.keys(stdio.env).length > 0 ? { ...stdio.env } : undefined;
  return {
    type: "local",
    command: [stdio.command, ...(stdio.args ?? [])],
    // The session's identity and capability ride here, in a 0600 file, for the
    // same reason they do for every other engine: a remote command line is
    // readable by every process on that host.
    ...(environment ? { environment } : {}),
    enabled: true,
  };
}

/** A URL-backed server as opencode takes it, or null when the spec is not one. */
function projectUrlServer(spec: Record<string, unknown>): OpencodeRemoteMcpServer | null {
  const url = spec as unknown as McpServerUrlConfig & { headers?: Record<string, string> };
  if (typeof url.url !== "string" || !url.url) return null;
  const headers = url.headers && Object.keys(url.headers).length > 0 ? { ...url.headers } : undefined;
  return { type: "remote", url: url.url, ...(headers ? { headers } : {}), enabled: true };
}

/**
 * Project one resolved MCP server into opencode's shape, or null when opencode
 * has no way to run it.
 *
 * Null rather than a best guess: a server hundredfold could not project is one the
 * model would be told about and then fail to call, and a half-wired toolset is
 * harder to diagnose than a missing one.
 */
export function projectOpencodeMcpServer(spec: unknown): OpencodeMcpServer | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const record = spec as Record<string, unknown>;
  return projectStdioServer(record) ?? projectUrlServer(record);
}

/** Every server in a resolved set that opencode can run. Pure, and shared by the
 *  local and the remote path so the two can never disagree about which tools a
 *  session carries. */
export function projectMcpForOpencode(resolvedMcp: ResolvedMcpConfig | undefined): Record<string, OpencodeMcpServer> {
  const out: Record<string, OpencodeMcpServer> = {};
  for (const [name, spec] of Object.entries(resolvedMcp?.mcpServers ?? {})) {
    const projected = projectOpencodeMcpServer(spec);
    if (projected) out[name] = projected;
  }
  return out;
}

/** The name of the built-in server when the resolved set is a purpose-built toolset: that
 *  server, built with `--hundredfold-toolset`, is the session's entire MCP surface. */
function purposeBuiltToolsetServer(resolvedMcp: ResolvedMcpConfig | undefined): string | undefined {
  const builtin = findBuiltinMcp(resolvedMcp?.mcpServers);
  const args = (builtin?.spec as { args?: unknown } | undefined)?.args;
  return Array.isArray(args) && args.includes(MCP_TOOLSET_ARG) ? builtin?.name : undefined;
}

/** The config file's contents for a session, or undefined when it carries no
 *  servers — opencode's own config is then left entirely alone. A purpose-built
 *  toolset session also carries the confined agent that clamps its tools. */
export function buildOpencodeSessionConfig(resolvedMcp: ResolvedMcpConfig | undefined): OpencodeSessionConfig | undefined {
  const mcp = projectMcpForOpencode(resolvedMcp);
  if (Object.keys(mcp).length === 0) return undefined;
  const toolsetServer = purposeBuiltToolsetServer(resolvedMcp);
  return {
    $schema: OPENCODE_CONFIG_SCHEMA,
    mcp,
    ...(toolsetServer
      ? { agent: { [OPENCODE_WALK_AGENT]: { mode: "primary" as const, permission: boardWalkAgentPermission(toolsetServer) } } }
      : {}),
  };
}

/** One permission rule in OpenCode 2's config. */
export interface OpencodeV2PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** The staged config in OpenCode 2's own shape (see the header). */
export interface OpencodeV2SessionConfig {
  $schema: string;
  mcp: { servers: Record<string, Omit<OpencodeMcpServer, "enabled"> & { codemode: false }> };
  plugins?: string[];
  agents?: Record<string, { mode: "primary"; permissions: OpencodeV2PermissionRule[] }>;
  /** The same `provider` blocks as 1.x's: OpenCode 2 reads them in this shape too. */
  provider?: Record<string, OpencodeProviderBlock>;
}

/** The 1.x config, as OpenCode 2 takes it: each server kept a tool server
 *  (`codemode: false`), and the confined agent's map as rules, default first. */
export function toOpencodeV2SessionConfig(config: OpencodeSessionConfig): OpencodeV2SessionConfig {
  const servers: OpencodeV2SessionConfig["mcp"]["servers"] = {};
  for (const [name, { enabled: _enabled, ...server }] of Object.entries(config.mcp)) servers[name] = { ...server, codemode: false };
  const agents = config.agent
    ? Object.fromEntries(Object.entries(config.agent).map(([name, agent]) => [name, {
      mode: agent.mode,
      permissions: Object.entries(agent.permission).map(([action, effect]) => ({ action, resource: "*", effect: effect as OpencodeV2PermissionRule["effect"] })),
    }]))
    : undefined;
  return {
    $schema: config.$schema,
    mcp: { servers },
    ...(config.plugin?.length ? { plugins: config.plugin } : {}),
    ...(agents ? { agents } : {}),
    ...(config.provider ? { provider: config.provider } : {}),
  };
}

/** The accounts' `provider` blocks for a binary of this API, or undefined when there are none. */
function accountProviders(accounts: OpencodeAccountStaging | undefined, api: OpencodeApi): Record<string, OpencodeProviderBlock> | undefined {
  const providers = accounts?.providers(api);
  return providers && Object.keys(providers).length > 0 ? providers : undefined;
}

/** The config file for a session in the shape its binary's API reads, with
 *  `plugins` added to the operator's own and one `provider` block per account
 *  (staged even without MCP servers). */
export function buildOpencodeSessionConfigFor(
  resolvedMcp: ResolvedMcpConfig | undefined,
  api: OpencodeApi,
  plugins: string[] = [],
  accounts?: OpencodeAccountStaging,
): OpencodeSessionConfig | OpencodeV2SessionConfig | undefined {
  const provider = accountProviders(accounts, api);
  const base = buildOpencodeSessionConfig(resolvedMcp) ?? (plugins.length || provider ? { $schema: OPENCODE_CONFIG_SCHEMA, mcp: {} } : undefined);
  if (!base) return undefined;
  const config = { ...base, ...(plugins.length ? { plugin: plugins } : {}), ...(provider ? { provider } : {}) };
  return api === 2 ? toOpencodeV2SessionConfig(config) : config;
}

/** Serialize the staged config exactly as both transports write it. */
export function serializeOpencodeSessionConfig(config: OpencodeSessionConfig | OpencodeV2SessionConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Write this session's config under the gateway's own home (local turns). */
export function writeOpencodeSessionConfig(
  resolvedMcp: ResolvedMcpConfig | undefined,
  sessionId: string,
  api: OpencodeApi = 1,
  plugins: string[] = [],
  accounts?: OpencodeAccountStaging,
): OpencodeConfigHandle {
  const config = buildOpencodeSessionConfigFor(resolvedMcp, api, plugins, accounts);
  if (!config) return { staged: false };

  const configDir = path.join(HUNDREDFOLD_HOME, "tmp", "opencode", safeSessionId(sessionId));
  const configPath = path.join(configDir, "opencode.json");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, serializeOpencodeSessionConfig(config), { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return { staged: true, configPath, configDir };
}

export function cleanupOpencodeSessionConfig(handle: OpencodeConfigHandle | undefined): void {
  if (!handle || !handle.staged || handle.released) return;
  handle.released = true;
  try {
    fs.rmSync(handle.configDir, { recursive: true, force: true });
  } catch {
    /* best effort temp cleanup */
  }
}
