import { findSessionTranscript } from "../engines/claude-transcript-path.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import type { JinnConfig, Session } from "../shared/types.js";
import { getEngineSessionRef } from "./registry.js";
import { sessionClaudeProfile } from "./session-account.js";
import { transcriptCwd } from "./session-cwd.js";
import { sessionScopeDepartment } from "./session-scope.js";

/**
 * The left Claude conversation's transcript path, found while the row still names it (before a
 * switch writes the target); none for a department-scoped or remote session, one not on Claude,
 * or one with no conversation yet. Recorded on `lastSwitch.leftTranscript` for the history pointer.
 */
export function leftTranscriptOf(session: Session, config: JinnConfig): string | undefined {
  if (session.engine !== "claude" || sessionScopeDepartment(session)) return undefined;
  const employee = session.employee ? orgRegistry(config).get(session.employee) : undefined;
  if (isRemoteTarget(employee)) return undefined;
  const id = getEngineSessionRef(session, "claude").id;
  return id ? findSessionTranscript(id, sessionClaudeProfile(session, employee), transcriptCwd(session)) : undefined;
}
