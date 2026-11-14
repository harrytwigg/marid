import { createSession, getSessionBySourceRef } from "../../sessions/registry.js";
import { REMOTE_MCP_SESSION_SOURCE } from "../../sessions/remote-mcp-session.js";
import type { Session } from "../../shared/types.js";

/**
 * The connector anchor for one verified identity (D1): an ordinary
 * session row, found by `sourceRef` or created on the identity's first call. It
 * is the principal the connector's tool calls run as, so every write it makes is
 * attributed to it on the dashboard (FR-012). It never runs an engine (D3,
 * sessions/turn/preflight.ts) and is never portal-shaped (D2, registry.ts).
 */
export function ensureRemoteMcpAnchor(email: string, engine: string): Session {
  const sourceRef = `${REMOTE_MCP_SESSION_SOURCE}:${email}`;
  const existing = getSessionBySourceRef(sourceRef);
  if (existing && existing.source === REMOTE_MCP_SESSION_SOURCE) return existing;
  return createSession({
    engine,
    source: REMOTE_MCP_SESSION_SOURCE,
    sourceRef,
    connector: null,
    title: `Remote MCP connector (${email})`,
  });
}
