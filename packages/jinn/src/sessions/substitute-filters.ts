import { declaredAccountByKey } from "../shared/claude-accounts-config.js";
import { DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import { engineSupportsRemote, type EngineName } from "../shared/models.js";
import { isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import type { Employee, JinnConfig, Session } from "../shared/types.js";
import { rateLimitRemoteTarget } from "./rate-limit-remote-target.js";
import { sessionScopeDepartment } from "./session-scope.js";

/**
 * What decides which fallback entries a session may use, shared by the turn
 * that picks a substitute (`rate-limit-substitute.ts`) and the display that
 * says what it would pick (`session-fallback.ts`), so the two cannot drift.
 */

/** Whether a session is department-scoped (FR-026a): it must stay on claude, so only
 *  Claude-account entries apply. `sessionScopeDepartment` is the one answer; a remote
 *  target's department counts too, for a session whose binding was lost. */
export function substituteScoped(session: Session, remoteTarget: { remoteDepartment?: string | null }): boolean {
  return Boolean(sessionScopeDepartment(session) ?? remoteTarget.remoteDepartment);
}

/** The structural half of "can this engine stand in": a scoped session takes claude only,
 *  and a remote one an engine that can also run on its host. Availability is the caller's. */
export function engineAllowedAsSubstitute(scope: { scoped: boolean; remote: boolean }, candidate: EngineName): boolean {
  return (!scope.scoped || candidate === "claude") && (!scope.remote || engineSupportsRemote(candidate));
}

/** An account's `fallbackModelMap`: the default account's lives under `engines.claude`. */
export function fallbackModelMapOf(config: JinnConfig, account: string): Record<string, string> | undefined {
  return account === DEFAULT_CLAUDE_ACCOUNT ? config.engines.claude?.fallbackModelMap : declaredAccountByKey(config, account)?.fallbackModelMap;
}

/** The scope a session's substitutes are filtered by: department-scoped, and/or running on a remote host. */
export function sessionSubstituteScope(
  session: Session, employee: Employee | undefined, config: JinnConfig,
): { scoped: boolean; remote: boolean; host?: string } {
  const remoteTarget = rateLimitRemoteTarget({ session, employee, config });
  const host = isRemoteTarget(remoteTarget) ? sshDestination(remoteTarget) : undefined;
  return { scoped: substituteScoped(session, remoteTarget), remote: host !== undefined, ...(host ? { host } : {}) };
}
