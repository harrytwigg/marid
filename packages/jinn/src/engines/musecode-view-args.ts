import type { ResolvedMcpConfig } from "../shared/types.js";
import { buildMuseSessionConfig, type MuseMcpServer } from "./musecode-mcp.js";

/**
 * How Muse Code's terminal view is launched: its argv and the environment that
 * carries the session's MCP secrets, as pure functions.
 *
 * The view is the TUI (`muse`, or `muse resume <id>`), not an MSP host. A TUI
 * takes no per-session MCP over a pipe; it reads `mcpServers` from its settings,
 * and `-c mcpServers.<name>=<json>` overrides one server for a single run. Muse
 * refuses a literal value for a secret leaf (a server's `env` and `headers`)
 * on the command line, and wants exactly one whole-value `${VAR}` naming a
 * variable that is set. So every such value rides in the view's own environment
 * under a generated name and the argv carries only the reference: no env or
 * header value is ever on a command line, where `ps` would show it. A server's
 * `command`, `args` and `url` are not secret leaves to Muse and travel as given,
 * so a credential placed there is visible in `ps`; keep credentials in `env` or `headers`.
 */

/** Settings every Muse process the gateway starts carries; the same two a turn's host gets. */
const FOREIGN_RULES_OFF = ["-c", "context.foreign_personal_rules=false", "-c", "context.foreign_personal_skills=false"];

/** Server names that can be addressed as `mcpServers.<name>` in a `-c` override. */
const ADDRESSABLE_NAME = /^[A-Za-z0-9_-]+$/;

/** Prefix of the environment variables that carry the view's MCP values. */
export const MUSE_VIEW_MCP_ENV_PREFIX = "MARID_MCP_";

export interface MuseViewLaunch {
  /** The conversation to open. Without one the view is a fresh TUI. */
  engineSessionId?: string;
  model?: string;
  /** The employee's own flags, appended last so they win. */
  cliFlags?: string[];
  resolvedMcp?: ResolvedMcpConfig;
}

export interface MuseViewArgs {
  args: string[];
  /** The variables the argv's `${VAR}` references name. Add them to the child's environment. */
  env: Record<string, string>;
  /** MCP servers left out because Muse cannot address them by name. */
  skippedServers: string[];
}

/** Replace every value of `record` with a reference to a variable that holds it. */
function referenced(record: Record<string, string> | undefined, env: Record<string, string>, nextVar: () => string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value !== "string" || value === "") continue;
    const name = nextVar();
    // Muse expands `${...}` in a value a second time, after resolving the reference, and `$$` is its escape.
    env[name] = value.split("$").join("$$");
    out[key] = `\${${name}}`;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function referencedServer(server: MuseMcpServer, env: Record<string, string>, nextVar: () => string): MuseMcpServer {
  if (server.transport === "stdio") {
    const { env: serverEnv, ...rest } = server;
    const ref = referenced(serverEnv, env, nextVar);
    return { ...rest, ...(ref ? { env: ref } : {}) };
  }
  const { headers, ...rest } = server;
  const ref = referenced(headers, env, nextVar);
  return { ...rest, ...(ref ? { headers: ref } : {}) };
}

/** One `-c mcpServers.<name>=<json>` per server the view should carry, with the variables they reference. */
export function buildMuseViewMcp(resolvedMcp: ResolvedMcpConfig | undefined): { flags: string[]; env: Record<string, string>; skipped: string[] } {
  const config = buildMuseSessionConfig(resolvedMcp);
  const flags: string[] = [];
  const env: Record<string, string> = {};
  const skipped: string[] = [];
  let counter = 0;
  const nextVar = () => `${MUSE_VIEW_MCP_ENV_PREFIX}${++counter}`;
  for (const [name, server] of Object.entries(config?.mcpServers ?? {})) {
    if (!ADDRESSABLE_NAME.test(name)) {
      skipped.push(name);
      continue;
    }
    flags.push("-c", `mcpServers.${name}=${JSON.stringify(referencedServer(server, env, nextVar))}`);
  }
  return { flags, env, skipped };
}

/**
 * `muse resume <id> …`, or plain `muse …` with no conversation to resume yet.
 *
 * `--disable-sandbox` and `--trust-workspace` for the reasons a turn's host has
 * them (see `musecode-protocol.ts`); trust is for this run and saves nothing, so
 * the terminal never stops at Muse's trust prompt. Approvals stay Muse's own,
 * since there is a person at this terminal to answer them.
 */
export function buildMuseViewArgs(launch: MuseViewLaunch): MuseViewArgs {
  const mcp = buildMuseViewMcp(launch.resolvedMcp);
  const args = [
    ...(launch.engineSessionId ? ["resume", launch.engineSessionId] : []),
    "--disable-sandbox",
    "--trust-workspace",
    ...FOREIGN_RULES_OFF,
    ...(launch.model ? ["--model", launch.model] : []),
    ...mcp.flags,
    ...(launch.cliFlags ?? []),
  ];
  return { args, env: mcp.env, skippedServers: mcp.skipped };
}
