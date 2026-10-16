import type { ServerResponse } from "node:http";
import type { Session } from "../shared/types.js";
import { getSession } from "../sessions/registry.js";
import { isAgentId, readSubagentTranscript, subagentTranscriptPath } from "../sessions/subagent-transcript.js";
import { json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";

export interface SubagentTranscriptDeps {
  /** The parent session's Claude conversation id, or undefined when it has none. */
  claudeSessionId(session: Session): string | undefined;
  /** Where Claude Code wrote that conversation's transcript, or undefined when the gateway cannot find it. */
  transcriptOf(session: Session, claudeSessionId: string): string | undefined;
  /** The department a scoped caller is held to, or null for anyone unscoped. */
  callerDepartment(): string | null;
}

/**
 * GET /api/sessions/:id/subagents/:agentId/transcript: what a background sub-agent of the session
 * said and did. Held to the session's own visibility rule, so a session the caller could not read
 * through `GET /api/sessions/:id` answers 404. A transcript the gateway cannot find or read is a 200
 * that says so, which the view shows as "not available".
 */
export function handleSubagentTranscriptApi(res: ServerResponse, route: ParsedRoute, deps: SubagentTranscriptDeps): boolean {
  const params = route.method === "GET" ? matchRoute("/api/sessions/:id/subagents/:agentId/transcript", route.pathname) : null;
  if (!params) return false;
  const department = deps.callerDepartment();
  const session = getSession(params.id);
  if (!session || (department !== null && session.scopeDepartment !== department)) {
    notFound(res);
    return true;
  }
  const ids = { sessionId: session.id, agentId: params.agentId };
  const claudeSessionId = deps.claudeSessionId(session);
  if (!isAgentId(params.agentId)) {
    json(res, { ...ids, available: false, reason: "not-found" });
  } else if (!claudeSessionId) {
    json(res, { ...ids, available: false, reason: "no-conversation" });
  } else {
    const parent = deps.transcriptOf(session, claudeSessionId);
    json(res, readSubagentTranscript(ids, parent && subagentTranscriptPath(parent, params.agentId)));
  }
  return true;
}
