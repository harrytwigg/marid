import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerStdioConfig, ResolvedMcpConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { stripMcpBootstrapArgs } from "../mcp/identity.js";
import { builtinMcpNames, findBuiltinMcp } from "../mcp/builtin-name.js";
import { NAMES, nameAliases } from "../shared/codename.js";
import { envAliases, envName } from "../shared/codename-env.js";

const MANAGED_ENV_KEY = envName("MCP_MANAGED_BY");
const SAFE_ENV_KEYS = new Set(["JINN_GATEWAY_URL", "JINN_HOME"]);

export const ANTIGRAVITY_JINN_MCP_MARKER = `${NAMES.codename}-managed-antigravity`;

/** Entries an earlier build wrote carry its own key and marker; they are as managed as ours. */
const MANAGED_ENV_KEYS = envAliases("MCP_MANAGED_BY");
const MANAGED_MARKERS = nameAliases((n) => `${n.codename}-managed-antigravity`);

export type AntigravityMcpConfigHandle =
  | { attached: false; reason?: string }
  | { attached: true; configPath: string; released?: boolean };

interface ActiveConfig {
  count: number;
}

const activeConfigs = new Map<string, ActiveConfig>();

function defaultConfigPath(): string {
  return path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
}

function jinnServer(resolvedMcp: ResolvedMcpConfig | undefined): { name: string; spec: McpServerStdioConfig } | null {
  const found = findBuiltinMcp(resolvedMcp?.mcpServers);
  const spec = found?.spec as (McpServerStdioConfig & { url?: unknown }) | undefined;
  if (found && spec && typeof spec.command === "string" && spec.command && spec.url === undefined) return { name: found.name, spec };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isManagedJinnServer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const env = value.env;
  return isRecord(env) && MANAGED_ENV_KEYS.some((key) => typeof env[key] === "string" && MANAGED_MARKERS.includes(env[key] as string));
}

function readConfig(configPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf-8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    logger.warn(`Antigravity MCP attach skipped: ${configPath} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
}

function renderJinnServer(spec: McpServerStdioConfig): McpServerStdioConfig {
  const env: Record<string, string> = { [MANAGED_ENV_KEY]: ANTIGRAVITY_JINN_MCP_MARKER };
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (SAFE_ENV_KEYS.has(key)) env[key] = value;
  }
  return {
    command: spec.command,
    args: stripMcpBootstrapArgs(spec.args),
    env,
  };
}

export function antigravityJinnSessionEnv(resolvedMcp: ResolvedMcpConfig | undefined): Record<string, string> {
  const spec = jinnServer(resolvedMcp)?.spec;
  const sessionId = spec?.env?.JINN_SESSION_ID;
  const capability = spec?.env?.JINN_SESSION_CAPABILITY;
  return sessionId && capability ? {
    JINN_SESSION_ID: sessionId,
    JINN_SESSION_CAPABILITY: capability,
  } : {};
}

/** Delete every entry under a reserved name that this program wrote, in place. Whether it removed any. */
function removeManagedEntries(servers: Record<string, unknown>): boolean {
  let removed = false;
  for (const name of builtinMcpNames()) {
    if (!isManagedJinnServer(servers[name])) continue;
    delete servers[name];
    removed = true;
  }
  return removed;
}

export function ensureAntigravityJinnMcpConfig(
  resolvedMcp: ResolvedMcpConfig | undefined,
  opts?: { configPath?: string },
): AntigravityMcpConfigHandle {
  const builtin = jinnServer(resolvedMcp);
  if (!builtin) return { attached: false, reason: "no built-in jinn MCP server in resolved config" };
  const { name, spec } = builtin;

  const configPath = opts?.configPath ?? defaultConfigPath();
  const active = activeConfigs.get(configPath);
  if (active) {
    active.count += 1;
    return { attached: true, configPath };
  }

  const config = readConfig(configPath);
  if (!config) return { attached: false, reason: "invalid config JSON" };

  const servers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
  if (servers[name] !== undefined && !isManagedJinnServer(servers[name])) {
    logger.warn(`Antigravity MCP attach skipped: ${configPath} already has a non-Jinn-managed "${name}" server.`);
    return { attached: false, reason: "non-managed jinn server exists" };
  }
  // An entry this program wrote under the other reserved name is stale once the instance registers under this one.
  removeManagedEntries(servers);

  servers[name] = renderJinnServer(spec);
  const next = { ...config, mcpServers: servers };
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  activeConfigs.set(configPath, { count: 1 });
  return { attached: true, configPath };
}

export function cleanupAntigravityJinnMcpConfig(handle: AntigravityMcpConfigHandle | undefined): void {
  if (!handle || !handle.attached || handle.released) return;
  handle.released = true;
  const active = activeConfigs.get(handle.configPath);
  if (!active) return;
  active.count -= 1;
  if (active.count > 0) return;
  activeConfigs.delete(handle.configPath);

  const config = readConfig(handle.configPath);
  if (!config) return;
  const servers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
  if (!removeManagedEntries(servers)) return;
  const next = { ...config, mcpServers: servers };
  try {
    fs.writeFileSync(handle.configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* best effort cleanup */
  }
}
