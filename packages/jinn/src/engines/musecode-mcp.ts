import type { McpServerStdioConfig, McpServerUrlConfig, ResolvedMcpConfig } from "../shared/types.js";

/**
 * The session's MCP servers, as Muse Code takes them.
 *
 * MSP accepts MCP servers per session, in `session/start` and `session/resume`
 * (`config.mcpServers`), so nothing is staged on disk and nothing goes on an
 * argv: a stdio server's environment (which carries the session's identity and
 * capability) and an HTTP server's headers travel over the host's stdin pipe.
 *
 * Every server is `optional`. Muse's default, `required`, fails the whole turn
 * with a `configError` when one server cannot start, which would let one bad
 * entry take down every turn of every employee on the engine; the other engines
 * run on without a server that will not start. Muse reports nothing about an
 * optional server it skipped (no notification, no item, no status in the
 * protocol), so there is nothing to surface: the session simply has no tools
 * from it.
 */

export type MuseMcpServerMode = "required" | "optional";

export type MuseMcpServer =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; mode: MuseMcpServerMode }
  | { transport: "streamableHttp"; url: string; headers?: Record<string, string>; mode: MuseMcpServerMode };

function nonEmpty<T extends Record<string, string>>(record: T | undefined): T | undefined {
  return record && Object.keys(record).length > 0 ? record : undefined;
}

const OPTIONAL = { mode: "optional" } as const;

function projectStdio(spec: McpServerStdioConfig): MuseMcpServer | null {
  if (typeof spec.command !== "string" || !spec.command) return null;
  const args = spec.args?.length ? { args: [...spec.args] } : {};
  const env = nonEmpty(spec.env);
  return { transport: "stdio", command: spec.command, ...args, ...(env ? { env: { ...env } } : {}), ...OPTIONAL };
}

function projectUrl(spec: McpServerUrlConfig): MuseMcpServer | null {
  if (typeof spec.url !== "string" || !spec.url) return null;
  const headers = nonEmpty(spec.headers);
  return { transport: "streamableHttp", url: spec.url, ...(headers ? { headers: { ...headers } } : {}), ...OPTIONAL };
}

/** One resolved server as MSP takes it, or null when Muse has no way to run it. */
export function projectMuseMcpServer(spec: unknown): MuseMcpServer | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  return projectStdio(spec as McpServerStdioConfig) ?? projectUrl(spec as McpServerUrlConfig);
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
    const projected = projectMuseMcpServer(spec);
    if (projected) mcpServers[name] = projected;
  }
  return Object.keys(mcpServers).length > 0 ? { mcpServers } : undefined;
}
