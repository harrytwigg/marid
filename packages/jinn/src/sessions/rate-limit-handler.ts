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
import { rateLimitRemoteTarget } from "./rate-limit-remote-target.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { spawnCwd } from "./session-cwd.js";
import { logger } from "../shared/logger.js";
import { REMOTE_ENGINE_NAMES } from "../shared/models.js";
import { linkHealthKey } from "../shared/fallback-chain-health.js";
import {
  computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit, nextUnstatedParkDelayMs,
  rateLimitEngineLabel, MAX_UNSTATED_PARK_ATTEMPTS,
} from "../shared/rateLimit.js";
import { rateLimitAccount, recordAccountRateLimit } from "./rate-limit-account.js";
import { walkFallbackChain } from "./fallback-walk.js";
import { chainExhaustedLastError } from "./fallback-hop.js";
import { standingOverrideUntil } from "./engine-override.js";
import { earlier, handBack, handBackAt as accountHandBackAt } from "./rate-limit-handback.js";
import { getSession, updateSessionForAttempt, nextEngineSessionFields } from "./registry.js";
import { runtimeSessionSource } from "./context.js";

const WAIT_CANCEL_POLL_MS = 5000;

export type {
  RateLimitHandlerHooks, RateLimitHandlerOpts, RateLimitInfo, RateLimitOutcome,
} from "./rate-limit-contract.js";

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
    mcpConfigPath, resolvedMcp, attachments, employee, engine,
    rateLimit, originalResult, hooks,
  } = opts;

  const engineLabel = rateLimitEngineLabel(session.engine);

  // Where this turn actually runs: the employee record first, the target the turn ran with as the fallback.
  const remoteTarget = rateLimitRemoteTarget(opts);

  const { claudeProfile, account } = rateLimitAccount(session.engine, employee, session);
  // Held against the target that ran: its account for Claude, its provider for an opencode model, its engine otherwise.
  const limitedKey = linkHealthKey({ engine: session.engine, model: session.model ?? engineConfig.model, account });
  recordAccountRateLimit(account, session.engine, engineLabel, rateLimit.resetsAt, limitedKey);

  // ── Branch A: hand the turn along this session's fallback chain ───────────
  // A remote employee's substitute has to be an engine that can ALSO run on that
  // host; hand the turn to one that ignores `remoteHost` and it runs on the
  // gateway — unattended, with --dangerously-skip-permissions, against a
  // repository deliberately never cloned there. A chain with nothing left in it
  // falls through to Branch B, which waits the limit out where the work lives.
  const remote = isRemoteTarget(remoteTarget) ? remoteTarget : undefined;
  const walk = await walkFallbackChain({ opts, remote, remoteTarget, limited: { engine: session.engine, account } });
  if (walk.kind === "cancelled") {
    await hooks.onCancelled?.();
    return { kind: "cancelled" };
  }
  if (walk.kind === "served") return { kind: "fallback", result: walk.result };
  if (remote) {
    logger.info(
      `Session ${session.id} runs on ${remote.remoteHost} — nothing in ${engineLabel}'s fallback chain can run there `
      + `(a substitute must be one of ${REMOTE_ENGINE_NAMES.join(", ")} and installed on that host); waiting for the reset instead`,
    );
  }
  const targetReason = walk.reason;
  // Nothing usable in the chain — fall through to wait-and-retry.

  // ── Branch B: wait-and-retry on the original engine ────────────────────────
  const { delayMs, resumeAt: limitResetAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
  const deadlineMs = computeRateLimitDeadlineMs(
    rateLimit.resetsAt,
    rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
  );
  // A session on a substitute Claude account goes back to its own at the
  // override's `until`, which can be days before a weekly-limited substitute
  // resets, so the wait ends there at the latest. So does one on any stand-in
  // whose chain just ran out: it waits for its own target, which is when the override ends.
  const handBackAt = accountHandBackAt(session) ?? (walk.walked ? standingOverrideUntil(session) : undefined);
  const resumeAt = earlier(limitResetAt, handBackAt);
  const threadFields = originalResult.sessionId?.trim() ? nextEngineSessionFields(session, session.engine, originalResult.sessionId) : {};
  // The window closed while this turn ran: the own account has already reopened, so there is nothing to wait for.
  if (handBackAt && Date.now() >= handBackAt.getTime()) {
    return await handBack(session.id, attemptToken, hooks, { waited: false, fields: threadFields });
  }

  logger.info(
    `Session ${session.id} hit ${engineLabel} usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`
    + (handBackAt && resumeAt === handBackAt ? " on its own target" : ""),
  );

  const enteredWaiting = updateSessionForAttempt(session.id, attemptToken, {
    ...threadFields,
    status: "waiting",
    lastActivity: new Date().toISOString(),
    // A chain that ran out names the own target and when it reopens; any other wait keeps its wording.
    lastError: walk.exhausted ? chainExhaustedLastError(walk.exhausted.own, resumeAt) : (resumeAt
      ? `${engineLabel} usage limit — resumes ${resumeAt.toISOString()}`
      : `${engineLabel} usage limit — waiting for reset`) + (targetReason ? `; ${targetReason}` : ""),
  });
  if (!enteredWaiting) {
    await hooks.onCancelled?.();
    return { kind: "cancelled" };
  }

  await hooks.onWaitingStart?.({ resumeAt: resumeAt ?? null, rateLimit, ...(targetReason ? { reason: targetReason } : {}), ...(walk.hop ? { hop: walk.hop } : {}), ...(walk.exhausted ? { exhausted: walk.exhausted } : {}) });

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

    // With a hand-back pending the wait never times out: every sleep is capped at
    // `until` and the hand-back check follows it, so the loop ends there anyway,
    // even when a retry against the substitute runs past it.
    while (handBackAt || Date.now() < deadlineMs) {
      const stillWaiting = await waitWhileSessionWaiting(session.id, handBackAt ? Math.min(nextDelayMs, handBackAt.getTime() - Date.now()) : nextDelayMs);
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

      if (handBackAt && Date.now() >= handBackAt.getTime()) return await handBack(session.id, attemptToken, hooks, { waited: true });

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
        const nextResumeAt = earlier(next.resumeAt, handBackAt);
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
          lastError: nextResumeAt
            ? `${engineLabel} usage limit — resumes ${nextResumeAt.toISOString()}`
            : `${engineLabel} usage limit — waiting for reset`,
        });
        if (!waitingAgain) {
          await hooks.onCancelled?.();
          return { kind: "cancelled" };
        }

        await hooks.onStillLimited?.({ attempt, resumeAt: nextResumeAt ?? null });
        if (unstatedAttempts >= MAX_UNSTATED_PARK_ATTEMPTS && !handBackAt) {
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
