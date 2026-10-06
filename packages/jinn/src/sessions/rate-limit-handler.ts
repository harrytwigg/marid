/**
 * Shared rate-limit / fallback / wait-and-retry handler.
 *
 * Both the connector path (sessions/manager.ts → runSession) and the web path
 * (gateway/api.ts → runWebSession) need to:
 *   1. Detect an engine usage-limit response.
 *   2. Hand the turn to the first engine in the limited one's chain that can serve one.
 *   3. Otherwise enter a "waiting" loop: sleep until the reset window, retry on the same engine,
 *      keep the session's lastActivity heartbeat fresh, and loop again if still limited.
 *   4. Bail out when the deadline passes without recovery.
 *
 * The state machine, engine invocations, retry math, heartbeat cadence, deadline
 * computation, and `transportMeta.engineOverride` bookkeeping are identical between
 * the two call sites — only the transport-side UI/notification details differ.
 * This module owns the common bits; per-transport behavior is injected via hooks.
 *
 * Per-engine thread ids live in the typed `engineSessions` refs the registry owns
 * (read with getEngineSessionRef, written with nextEngineSessionFields folded into
 * this module's existing attempt fences) — never in a transport-meta blob.
 *
 * Behavior is intentionally preserved verbatim from the original inlined
 * implementations — do not "improve" the wait math, the per-step state writes,
 * or the order of side effects without auditing both call sites.
 */

import type { RateLimitHandlerOpts, RateLimitOutcome } from "./rate-limit-contract.js";
import type { Engine, EngineResult } from "../shared/types.js";
import { rateLimitRemoteTarget } from "./rate-limit-remote-target.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { spawnCwd } from "./session-cwd.js";
import { logger } from "../shared/logger.js";
import { REMOTE_ENGINE_NAMES, type EngineName } from "../shared/models.js";
import {
  computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit, nextUnstatedParkDelayMs,
  rateLimitEngineLabel, MAX_UNSTATED_PARK_ATTEMPTS,
} from "../shared/rateLimit.js";
import { rateLimitAccount, recordAccountRateLimit } from "./rate-limit-account.js";
import { chooseSubstitute } from "./rate-limit-substitute.js";
import { beginEngineSubstitution, standingOverrideUntil } from "./engine-override.js";
import { resolveEngineRunMcp } from "./engine-run-mcp.js";
import { getSession, getMessages, updateSessionForAttempt, nextEngineSessionFields } from "./registry.js";
import { runtimeSessionSource } from "./context.js";

const WAIT_CANCEL_POLL_MS = 5000;

export type {
  RateLimitHandlerHooks, RateLimitHandlerOpts, RateLimitInfo, RateLimitOutcome,
} from "./rate-limit-contract.js";

/**
 * Run the substitute, turning a thrown spawn into the error result every other
 * engine failure already is.
 *
 * The catch is not defensive clutter — it closes a settle hole that only exists
 * on this branch. `beginEngineSubstitution` has ALREADY written the substitute's
 * name onto the session, so a throw escaping here reaches the turn runner's
 * catch (`turn/runner.ts`), where `claimSettleableSession` compares the live
 * `session.engine` against the plan's and finds them different — it drops the
 * error as stale, `settleThrownTurn` never runs, and the session is left at
 * `running` with nothing reported: the silent stall this whole path exists to
 * avoid. Engines are entitled to throw (every CLI adapter rejects when its
 * binary cannot be spawned, and the remote adapters throw when the host is not
 * ready), so the fix belongs here, where the identity was changed.
 *
 * Reported as a result rather than swallowed into Branch B: the session has been
 * flipped and the operator was already told a substitute is running, so the
 * honest outcome is that substitute failing, with its reason.
 */
async function runSubstitute(
  engine: Engine,
  substituteName: EngineName,
  sessionId: string,
  opts: Parameters<Engine["run"]>[0],
): Promise<EngineResult> {
  try {
    return await engine.run(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Session ${sessionId}: ${rateLimitEngineLabel(substituteName)} substitution failed to start: ${message}`);
    return { sessionId: "", result: "", error: `${rateLimitEngineLabel(substituteName)} could not start: ${message}` };
  }
}

/**
 * Drive the rate-limit recovery state machine. Returns once the situation
 * resolves (success, fallback completion, timeout, or cancellation).
 *
 * The caller has ALREADY detected the rate limit and confirmed it should be
 * handled (i.e. not a dead session, not an interrupted turn).
 */
export async function handleRateLimit(opts: RateLimitHandlerOpts): Promise<RateLimitOutcome> {
  const {
    session, attemptToken, prompt, systemPrompt, platformContextRefresh, engineConfig, effortLevel, cliFlags,
    mcpConfigPath, resolvedMcp, attachments, config, engines, employee, engine,
    rateLimit, originalResult, hooks,
  } = opts;

  const engineLabel = rateLimitEngineLabel(session.engine);

  // Where this turn actually runs: the employee record first, the target the turn ran with as the fallback.
  const remoteTarget = rateLimitRemoteTarget(opts);

  const { claudeProfile, account } = rateLimitAccount(session.engine, employee, session);
  recordAccountRateLimit(account, session.engine, engineLabel, rateLimit.resetsAt);

  // ── Branch A: hand the turn to this account's chain ────────────────────────
  // A remote employee's substitute has to be an engine that can ALSO run on that
  // host; hand the turn to one that ignores `remoteHost` and it runs on the
  // gateway — unattended, with --dangerously-skip-permissions, against a
  // repository deliberately never cloned there. A chain with nothing left in it
  // falls through to Branch B, which waits the limit out where the work lives.
  const remote = isRemoteTarget(remoteTarget) ? remoteTarget : undefined;
  const choice = chooseSubstitute({ config, engines, session, employee, account, remote, remoteTarget });
  const substituteName = choice?.engine;
  const substituteEngine = substituteName ? engines.get(substituteName) : undefined;
  if (!substituteName && remote) {
    logger.info(
      `Session ${session.id} runs on ${remote.remoteHost} — nothing in ${engineLabel}'s fallback chain can run there `
      + `(a substitute must be one of ${REMOTE_ENGINE_NAMES.join(", ")} and installed on that host); waiting for the reset instead`,
    );
  }
  if (choice && substituteName && substituteEngine) {
    const substituteCwd = spawnCwd(session, Boolean(remote)); // a scoped session's stage directory, resolved before anything is flipped
    const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
    const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
    const syncSince = new Date().toISOString();
    const substituteLabel = choice.accounts ? `the ${choice.accounts.substitute} Claude account` : rateLimitEngineLabel(substituteName);

    await hooks.onFallbackStart?.({ resumeAt: resumeAt ?? null, until, substitute: substituteName });

    // A swap made while another stands keeps that swap's window, so the session stays on the substitute until then.
    const backAt = standingOverrideUntil(session) ?? resumeAt;
    const substitution = beginEngineSubstitution({
      session, attemptToken, config, employee, substitute: substituteName, accounts: choice.accounts, until, syncSince,
      lastError: backAt
        ? `${engineLabel} usage limit — using ${substituteLabel} until ${backAt.toISOString()}`
        : `${engineLabel} usage limit — using ${substituteLabel} temporarily`,
    });
    if (!substitution) {
      await hooks.onCancelled?.();
      return { kind: "cancelled" };
    }

    const substituteResume = substitution.resumeSessionId;
    const history = getMessages(session.id)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
    const historyText = history.slice(-12).join("\n\n");
    const fallbackPrompt = substituteResume
      ? prompt
      : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;

    const fallbackResult = await runSubstitute(substituteEngine, substituteName, session.id, {
      prompt: fallbackPrompt,
      resumeSessionId: substituteResume,
      systemPrompt,
      cwd: substituteCwd,
      // The substitute runs as itself: its own binary, the MCP payload resolved for it,
      // and a model it actually serves — the limited engine's would be meaningless here.
      bin: substitution.engineConfig.bin,
      model: substitution.model ?? substitution.engineConfig.model,
      effortLevel: substitution.effortLevel,
      cliFlags: employee?.cliFlags ?? cliFlags,
      // Where it runs. `cwd` above is the gateway's and means nothing on the other
      // machine; the substitute branches on `remoteHost` and uses `remoteCwd`
      // instead. Omit this and a remote employee's fallback turn comes back to the
      // gateway — the failure Branch A used to be skipped entirely to avoid.
      ...remoteTarget,
      ...resolveEngineRunMcp({ config, employee, engine: substituteName, sessionId: session.id }),
      claudeProfile: choice.claudeProfile,
      attachments: attachments?.length ? attachments : undefined,
      sessionId: session.id,
      ...(hooks.onFallbackStream ? { onStream: hooks.onFallbackStream } : {}),
    });

    // Persist the substitute's thread id so future fallbacks can resume it —
    // and so the mirror stops lying about which engine the id belongs to.
    const live = getSession(session.id);
    if (live && fallbackResult.sessionId) {
      // The live row carries the override, so an account substitute's id lands in its own account's slot.
      updateSessionForAttempt(session.id, attemptToken, nextEngineSessionFields(live, substituteName, fallbackResult.sessionId));
    }

    await hooks.onFallbackComplete?.(fallbackResult, {
      engine: substituteName,
      model: substitution.model ?? substitution.engineConfig.model,
    });

    return { kind: "fallback", result: fallbackResult };
  }
  // Nothing usable in the chain — fall through to wait-and-retry.

  // ── Branch B: wait-and-retry on the original engine ────────────────────────
  const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
  const deadlineMs = computeRateLimitDeadlineMs(
    rateLimit.resetsAt,
    rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
  );

  logger.info(
    `Session ${session.id} hit ${engineLabel} usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
  );

  const enteredWaiting = updateSessionForAttempt(session.id, attemptToken, {
    ...(originalResult.sessionId?.trim() ? nextEngineSessionFields(session, session.engine, originalResult.sessionId) : {}),
    status: "waiting",
    lastActivity: new Date().toISOString(),
    lastError: resumeAt
      ? `${engineLabel} usage limit — resumes ${resumeAt.toISOString()}`
      : `${engineLabel} usage limit — waiting for reset`,
  });
  if (!enteredWaiting) {
    await hooks.onCancelled?.();
    return { kind: "cancelled" };
  }

  await hooks.onWaitingStart?.({ resumeAt: resumeAt ?? null, rateLimit });

  // Keep lastActivity fresh while waiting (UI / status endpoints).
  const heartbeat = setInterval(() => {
    if (getSession(session.id)?.status === "waiting") {
      updateSessionForAttempt(session.id, attemptToken, { status: "waiting", lastActivity: new Date().toISOString() }, ["waiting"]);
    }
  }, 60_000);

  try {
    let attempt = 0;
    let nextDelayMs = delayMs;
    // Consecutive retries against a limit that has still named no reset. Reset
    // to zero the moment one does, so a limit that starts stating a window goes
    // back to being slept to rather than guessed at.
    let unstatedAttempts = 0;

    while (Date.now() < deadlineMs) {
      const stillWaiting = await waitWhileSessionWaiting(session.id, nextDelayMs);
      if (!stillWaiting) {
        const currentSession = getSession(session.id);
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }
      attempt++;

      // Check if session was stopped while waiting. We set status:"waiting"
      // before entering this loop, so any other status (idle from a user
      // POST /stop, error from a crash, etc.) means the user/system pulled
      // us out of the waiting state and we should NOT retry. Previously this
      // only caught "error", so user-initiated stop ("idle") leaked through
      // and the retry fired against a session the user thought was stopped.
      const currentSession = getSession(session.id);
      if (!currentSession || currentSession.status !== "waiting") {
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      await hooks.onRetryAttempt?.({ attempt });
      logger.info(`Session ${session.id} retrying after usage limit (attempt ${attempt})`);

      const retryStarted = updateSessionForAttempt(session.id, attemptToken, {
        status: "running",
        lastActivity: new Date().toISOString(),
      }, ["waiting"]);
      if (!retryStarted) {
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      const retryResult = await engine.run({
        prompt,
        resumeSessionId: currentSession.engineSessionId ?? undefined,
        systemPrompt,
        platformContextRefresh,
        cwd: spawnCwd(session, Boolean(remote)),
        bin: engineConfig.bin,
        model: currentSession.model ?? engineConfig.model,
        effortLevel,
        cliFlags,
        // The retry is a fresh spawn, not a resume of the limited process, so it
        // re-states where the session runs. Omit this and a rate-limited remote
        // turn silently comes back on the gateway.
        ...remoteTarget,
        claudeProfile,
        mcpConfigPath,
        resolvedMcp,
        attachments: attachments?.length ? attachments : undefined,
        sessionId: session.id,
        source: runtimeSessionSource(session.source),
        ...(hooks.onRetryStream ? { onStream: hooks.onRetryStream } : {}),
      });

      const retryInterrupted = retryResult.error?.startsWith("Interrupted");
      const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };

      if (retryRateLimit.limited) {
        recordAccountRateLimit(account, session.engine, engineLabel, retryRateLimit.resetsAt);
        logger.info(`Session ${session.id} still rate limited (attempt ${attempt})`);

        const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
        if (next.resumeAt) {
          unstatedAttempts = 0;
          nextDelayMs = next.delayMs;
        } else {
          unstatedAttempts++;
          nextDelayMs = nextUnstatedParkDelayMs(nextDelayMs);
        }

        const waitingAgain = updateSessionForAttempt(session.id, attemptToken, {
          ...(retryResult.sessionId?.trim() ? nextEngineSessionFields(currentSession, currentSession.engine, retryResult.sessionId) : {}),
          status: "waiting",
          lastActivity: new Date().toISOString(),
          lastError: next.resumeAt
            ? `${engineLabel} usage limit — resumes ${next.resumeAt.toISOString()}`
            : `${engineLabel} usage limit — waiting for reset`,
        });
        if (!waitingAgain) {
          await hooks.onCancelled?.();
          return { kind: "cancelled" };
        }

        await hooks.onStillLimited?.({ attempt, resumeAt: next.resumeAt ?? null });
        if (unstatedAttempts >= MAX_UNSTATED_PARK_ATTEMPTS) {
          logger.warn(
            `Session ${session.id} stopping after ${unstatedAttempts} retries against a ${engineLabel} usage limit that never named a reset`,
          );
          break;
        }
        continue;
      }

      // Success (or non-rate-limit error) — hand off to caller for persistence + transport.
      await hooks.onRetrySuccess?.(retryResult);
      logger.info(`Session ${session.id} resumed after usage reset`);
      return { kind: "resumed", result: retryResult };
    }

    // Deadline exhausted, or the unstated-reset park gave up, without recovery.
    await hooks.onTimeout?.();
    logger.warn(`Session ${session.id} exhausted usage limit retries`);
    return { kind: "timeout" };
  } finally {
    clearInterval(heartbeat);
  }
}

async function waitWhileSessionWaiting(sessionId: string, delayMs: number): Promise<boolean> {
  const end = Date.now() + Math.max(0, delayMs);
  while (Date.now() < end) {
    const currentSession = getSession(sessionId);
    if (!currentSession || currentSession.status !== "waiting") return false;
    const sleepMs = Math.min(WAIT_CANCEL_POLL_MS, end - Date.now());
    if (sleepMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
  }
  const currentSession = getSession(sessionId);
  return !!currentSession && currentSession.status === "waiting";
}
