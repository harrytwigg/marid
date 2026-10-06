import type { ClaudeProfile } from "../shared/claude-profile.js";
import type { JinnConfig, Session } from "../shared/types.js";
import { sessionClaudeProfile } from "../sessions/session-account.js";
import { orgRegistry } from "./org-registry.js";

/**
 * The Claude profile a session runs on, read from its employee on the live
 * roster: null (the gateway's own profile) for a session with no employee, an
 * employee no longer on the roster, a remote employee, or one with no
 * `claudeConfigDir`. Everything that reads a session's Claude state from
 * outside a turn (transcripts, fork) asks this, so it agrees with the turn
 * that wrote that state.
 */
export function claudeProfileForSession(
  session: { employee?: string | null; transportMeta?: Session["transportMeta"] } | null | undefined,
  config?: JinnConfig,
): ClaudeProfile {
  if (!session?.employee) return session ? sessionClaudeProfile(session, null) : null;
  return sessionClaudeProfile(session, orgRegistry(config).get(session.employee));
}
