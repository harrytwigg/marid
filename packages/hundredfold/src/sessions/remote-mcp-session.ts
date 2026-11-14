import type { Session } from "../shared/types.js";

/**
 * `Session.source` of a remote MCP connector anchor: the identity a
 * claude.ai / Claude Code connector's tool calls run as. It is employee-less and
 * parentless by construction, which is exactly the shape `isPortalAgentSession`
 * reads as the COO portal — so that predicate excludes this source by literal
 * (sessions/registry.ts is over its size budget and cannot take an import), and
 * the portal test in gateway/__tests__/remote-mcp-rules.test.ts pins the two together.
 */
export const REMOTE_MCP_SESSION_SOURCE = "remote-mcp";

export function isRemoteMcpSession(session: Pick<Session, "source"> | null | undefined): boolean {
  return session?.source === REMOTE_MCP_SESSION_SOURCE;
}
