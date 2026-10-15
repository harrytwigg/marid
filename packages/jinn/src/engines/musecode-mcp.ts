import type { McpServerStdioConfig, McpServerUrlConfig, ResolvedMcpConfig } from "../shared/types.js";

/**
 * The company toolset, as Muse Code takes it.
 *
 * MSP accepts MCP servers per session, in `session/start` and `session/resume`
 * (`config.mcpServers`), so nothing is staged on disk and nothing goes on an
 * argv: a stdio server's environment (which carries the session's identity and
 * capability) and an HTTP server's headers travel over the host's stdin pipe.
 *
 * The `jinn` server is `optional`: a session whose company tools failed to
 * start still has its files and shell, and the turn can say so, where a
 * `required` server that never comes up would end the session before it began.
 * Every other server keeps Muse's own default.
 */

export type MuseMcpServerMode = "required" | "optional";

export type MuseMcpServer =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; mode?: MuseMcpServerMode }
  | { transport: "streamableHttp"; url: string; headers?: Record<string, string>; mode?: MuseMcpServerMode };

/** The name of the company toolset's server in a resolved set. */
const JINN_SERVER = "jinn";

function nonEmpty<T extends Record<string, string>>(record: T | undefined): T | undefined {
  return record && Object.keys(record).length > 0 ? record : undefined;
}

type Mode = { mode?: MuseMcpServerMode };

function projectStdio(spec: McpServerStdioConfig, mode: Mode): MuseMcpServer | null {
  if (typeof spec.command !== "string" || !spec.command) return null;
  const args = spec.args?.length ? { args: [...spec.args] } : {};
  const env = nonEmpty(spec.env);
  return { transport: "stdio", command: spec.command, ...args, ...(env ? { env: { ...env } } : {}), ...mode };
}

function projectUrl(spec: McpServerUrlConfig, mode: Mode): MuseMcpServer | null {
  if (typeof spec.url !== "string" || !spec.url) return null;
  const headers = nonEmpty(spec.headers);
  return { transport: "streamableHttp", url: spec.url, ...(headers ? { headers: { ...headers } } : {}), ...mode };
}

/** One resolved server as MSP takes it, or null when Muse has no way to run it. */
export function projectMuseMcpServer(name: string, spec: unknown): MuseMcpServer | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const mode: Mode = name === JINN_SERVER ? { mode: "optional" } : {};
  return projectStdio(spec as McpServerStdioConfig, mode) ?? projectUrl(spec as McpServerUrlConfig, mode);
}

/**
 * The `config` member of `session/start` and `session/resume`, or undefined
 * when the session carries no servers Muse can run.
 *
 * A server that cannot be projected is left out rather than guessed at: a tool
 * the model is told about and then cannot call is harder to diagnose than one
 * that is absent.
 */
export function buildMuseSessionConfig(resolvedMcp: ResolvedMcpConfig | undefined): { mcpServers: Record<string, MuseMcpServer> } | undefined {
  const mcpServers: Record<string, MuseMcpServer> = {};
  for (const [name, spec] of Object.entries(resolvedMcp?.mcpServers ?? {})) {
    const projected = projectMuseMcpServer(name, spec);
    if (projected) mcpServers[name] = projected;
  }
  return Object.keys(mcpServers).length > 0 ? { mcpServers } : undefined;
}
