import type { ClaudeProfile } from "../shared/claude-profile.js";
import type { JinnConfig, Session } from "../shared/types.js";
import { findSessionTranscript } from "../engines/claude-transcript-path.js";
import { sessionClaudeProfile } from "../sessions/session-account.js";
import { transcriptCwd } from "../sessions/session-cwd.js";
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

/** The transcript of `session`'s Claude session `engineSessionId`, on the profile and in the cwd the session ran in (the department's stage directory when it is scoped). */
export function findTranscriptOfSession(
  session: { employee?: string | null; scopeDepartment?: string | null; transportMeta?: Session["transportMeta"] },
  engineSessionId: string,
): string | undefined {
  return findSessionTranscript(engineSessionId, claudeProfileForSession(session), transcriptCwd(session));
}
