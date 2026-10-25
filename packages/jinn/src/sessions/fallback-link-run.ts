import { isClaudeAuthFailure, observeClaudeTurnOutcome, refuseClaudeLaunch } from "./claude-auth-watch.js";
import { verifyLocalClaudeProfile } from "../shared/claude-profile-signin.js";
import { linkHealthKey } from "../shared/fallback-chain-health.js";
import type { ResolvedFallbackLink } from "../shared/fallback-chain-wire.js";
import { logger } from "../shared/logger.js";
import type { EngineName } from "../shared/models.js";
import { detectRateLimit, rateLimitEngineLabel } from "../shared/rateLimit.js";
import type { Engine, EngineResult, Session } from "../shared/types.js";
import { limitReason, isInvalidModelFailure, type LinkFailure } from "./fallback-hop.js";
import type { WalkInput } from "./fallback-walk.js";
import { resolveEngineRunMcp } from "./engine-run-mcp.js";
import type { EngineSubstitution } from "./engine-override.js";
import { isRemoteClaudeAccount } from "../shared/engine-account.js";
import { recordAccountRateLimit } from "./rate-limit-account.js";
import type { SubstituteChoice } from "./rate-limit-substitute.js";

/**
 * Running one chain link and reading how it went: the launch gate for a Claude
 * profile, the engine call, and what a failed result means for the walk.
 */

/** The session as the auth ledger reads it for a launch on `choice`'s account: its override is the swap the link makes. */
function launchSession(choice: SubstituteChoice): Pick<Session, "transportMeta"> {
  const swap = choice.accounts;
  return { transportMeta: swap ? { engineOverride: { substituteAccount: swap.substitute, substituteConfigDir: swap.substituteConfigDir } } : null };
}

/**
 * Why a Claude link on a declared profile cannot be launched, or undefined: the
 * profile is missing or signed out, or the auth ledger says its login is down.
 * The same refusals a turn's preflight makes, asked before the session is moved
 * onto it. A link that runs as the employee's own account is not asked: that
 * account's turns have been through preflight already.
 */
export function claudeLinkRefusal(opts: WalkInput["opts"], choice: SubstituteChoice): string | undefined {
  if (choice.engine !== "claude" || !choice.accounts || !choice.claudeProfile) return undefined;
  const unsigned = verifyLocalClaudeProfile(choice.claudeProfile);
  if (unsigned) return unsigned;
  return refuseClaudeLaunch(opts.employee, new Date(), launchSession(choice));
}

/**
 * How a link's result moves the walk, or undefined when it does not (an answer,
 * or an ordinary failure, ends the walk there). A limit moves it on from any
 * link; a model the engine refuses and a Claude login that is down move it on
 * from a fallback link, which every link the walk runs is.
 */
export function linkFailure(result: EngineResult, engine: string): LinkFailure | undefined {
  if (result.error?.startsWith("Interrupted")) return undefined;
  const limit = detectRateLimit(result);
  if (limit.limited) return { reason: limitReason(result), ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }), isLimit: true };
  if (!result.error) return undefined;
  if (engine === "claude" && isClaudeAuthFailure(result.error)) return { reason: "auth", isLimit: false };
  return isInvalidModelFailure(result.error) ? { reason: "invalid-model", isLimit: false } : undefined;
}

/** Hold a limit against the link's target: its provider for an opencode model, its account for Claude, its engine for the rest. Claude's own memory of the limit is kept as before. */
export function recordLinkLimit(link: Pick<ResolvedFallbackLink, "engine" | "model" | "account">, resetsAt: number | undefined): void {
  recordAccountRateLimit(link.account, link.engine, rateLimitEngineLabel(link.engine), resetsAt, linkHealthKey(link));
}

export interface RunLinkArgs {
  walk: WalkInput;
  choice: SubstituteChoice;
  engine: Engine;
  substitution: EngineSubstitution;
  prompt: string;
  cwd: string;
}

/** The profile directory on the host for a link that moves a remote session onto a remote account; the employee's own dir (already on the target) otherwise. */
function remoteAccountDir(choice: SubstituteChoice): { remoteClaudeConfigDir?: string } {
  const swap = choice.accounts;
  return choice.engine === "claude" && swap && isRemoteClaudeAccount(swap.substitute) && swap.substituteConfigDir
    ? { remoteClaudeConfigDir: swap.substituteConfigDir }
    : {};
}

/**
 * Run the turn on the link, turning a thrown spawn into the error result every
 * other engine failure already is.
 *
 * The catch is not defensive clutter: the session has ALREADY been flipped onto
 * the link, so a throw escaping here reaches the turn runner's catch, where
 * `claimSettleableSession` compares the live `session.engine` against the plan's,
 * finds them different and drops the error as stale. `settleThrownTurn` never
 * runs and the session is left at `running` with nothing reported. Engines are
 * entitled to throw (every CLI adapter rejects when its binary cannot be
 * spawned, and the remote adapters throw when the host is not ready), so the fix
 * belongs where the identity was changed. Reported as a result rather than
 * swallowed into Branch B: the operator was told a substitute is running, so the
 * honest outcome is that substitute failing, with its reason.
 */
export async function runLink(args: RunLinkArgs): Promise<EngineResult> {
  const { walk, choice, engine, substitution, prompt, cwd } = args;
  const { opts, remoteTarget } = walk;
  const name = choice.engine as EngineName;
  try {
    return await engine.run({
      prompt,
      resumeSessionId: substitution.resumeSessionId,
      systemPrompt: opts.systemPrompt,
      cwd,
      // The substitute runs as itself: its own binary, the MCP payload resolved for it,
      // and a model it actually serves — the limited engine's would be meaningless here.
      bin: substitution.engineConfig.bin,
      model: substitution.model ?? substitution.engineConfig.model,
      effortLevel: substitution.effortLevel,
      cliFlags: opts.employee?.cliFlags ?? opts.cliFlags,
      // Where it runs. `cwd` above is the gateway's and means nothing on the other
      // machine; the substitute branches on `remoteHost` and uses `remoteCwd`
      // instead. Omit this and a remote employee's fallback turn comes back to the
      // gateway — the failure Branch A used to be skipped entirely to avoid.
      ...remoteTarget,
      ...remoteAccountDir(choice),
      ...resolveEngineRunMcp({ config: opts.config, employee: opts.employee, engine: name, sessionId: opts.session.id }),
      claudeProfile: choice.claudeProfile,
      attachments: opts.attachments?.length ? opts.attachments : undefined,
      sessionId: opts.session.id,
      ...(opts.hooks.onFallbackStream ? { onStream: opts.hooks.onFallbackStream } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Session ${opts.session.id}: ${rateLimitEngineLabel(name)} substitution failed to start: ${message}`);
    return { sessionId: "", result: "", error: `${rateLimitEngineLabel(name)} could not start: ${message}` };
  }
}

/** A launch on a Claude link came back refused: the auth ledger opens or extends the outage, as it does for a turn. */
export function noteLinkAuthFailure(opts: WalkInput["opts"], choice: SubstituteChoice, error: string): void {
  observeClaudeTurnOutcome(opts.employee, error, new Date(), launchSession(choice));
}
