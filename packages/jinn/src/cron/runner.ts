import type { CronJob, Connector, JinnConfig, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { appendRunLog } from "./jobs.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { CronConnector } from "../connectors/cron/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { getSession, getSessionBySessionKey } from "../sessions/registry.js";
import { createWorkItem, linkSession, type WorkItem } from "../work-items/store.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
import { notifyTodoChanged } from "../work-items/live-events.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import { runActionJob, type CronActionTrigger } from "./actions.js";

export interface RunCronJobOptions {
  /**
   * Deterministic identity of *this logical fire*, owned by the caller (the
   * scheduler captures it once at fire time). Drives `sessionKey`/`sourceRef` as
   * `cron:<jobId>:<fireIso>`, so a re-invocation of the same logical fire reuses the
   * session *row* by sessionKey and returns the existing work item + re-stamps the
   * same link, rather than creating a second of either (GRS-003b-1).
   *
   * Defaults to a fresh `new Date().toISOString()` when absent, so ad-hoc callers
   * (manual `/cron run`, HTTP run-now) get a per-call identity — every ad-hoc call is
   * a new fire by definition.
  */
  fireIso?: string;
  /** Gateway broadcast seam. Absent in CLI/unit contexts without a live server. */
  emit?: GatewayEmit;
  /** What fired the job. The scheduler passes `schedule`; every other caller is
   *  a person's run-now. Only an `action` job reads it. */
  trigger?: CronActionTrigger;
}

/**
 * How a settled session failed, or null if it did not. `attemptOutcome` is the
 * durable receipt for the attempt; `status === "error"` catches a session that was
 * left broken without ever getting one.
 */
function sessionFailure(session: Session): "failed" | "interrupted" | "error" | null {
  if (session.attemptOutcome === "failed" || session.attemptOutcome === "interrupted") {
    return session.attemptOutcome;
  }
  return session.status === "error" ? "error" : null;
}

export async function runCronJob(
  job: CronJob,
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
  opts?: RunCronJobOptions,
): Promise<void> {
  // A built-in action runs in the gateway: no session, no Todo, no prompt.
  if (job.action) {
    return runActionJob({ ...job, action: job.action }, { trigger: opts?.trigger ?? "manual", ...(opts?.emit ? { emit: opts.emit } : {}) });
  }
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting`);

  const delivery = job.delivery || config.cron?.defaultDelivery;
  const cooSlug = config.portal?.portalName?.toLowerCase() || "jinn";
  if (delivery && job.employee && job.employee !== cooSlug) {
    logger.debug(
      `Cron job "${job.name}" targets employee "${job.employee}" directly (skipping COO delegation).`,
    );
  }

  const connector = new CronConnector(connectors, delivery);
  const startedAt = new Date().toISOString();
  // Deterministic per-fire identity (GRS-003b-1). Caller-owned `fireIso` names this
  // logical fire; the default keeps per-call uniqueness for ad-hoc callers that don't
  // pass one.
  const fireIso = opts?.fireIso ?? new Date().toISOString();
  const sessionKey = `cron:${job.id}:${fireIso}`;

  // GRS-003b-2b — atomic-ordered cron-bridge (mint-before-spawn). The session spawn
  // (`route()` below) is the only non-DB, non-rollbackable step, so the durable work
  // item — the record of INTENT — is minted BEFORE it. When the mint SUCCEEDS, a crash
  // around the spawn never loses intent: the worst case is a recoverable `backlog` item with
  // zero linked sessions, never a stuck `executing` item the reconciler can't derive back.
  // (If the mint itself fails — best-effort — `route()` can still spawn a session with no
  // item. Nothing heals that residual orphan: startup reconcile derives only from linked
  // sessions, and node-cron does not redeliver a tick.)
  //
  // Status is `backlog` at mint (NOT `executing`): with zero linked sessions there is no
  // evidence to derive from, and `backlog` is exactly what the GRS-003a reconciler leaves
  // untouched (its zero-session rule). The LIVE status is DERIVED by `reconcileWorkItem`
  // after the session is linked (below) — status is never hardcoded here, which kills the
  // split-brain seed (the old bridge stamped a live status at mint, drifting from real state).
  //
  // Best-effort: a work-item failure must never break the actual cron job (the item is a
  // dogfood consumer, not load-bearing). `sessionKey` (`cron:<jobId>:<fireIso>`) is this
  // fire's deterministic source_ref, so a re-fire idempotently returns the SAME item
  // (partial UNIQUE on `(source, source_ref)`), reuses the session row, and re-links.
  //
  // Rejected alternative (criterion 2): mint-after-spawn + a rollback-safe mint+link
  // transaction. Because the spawn is irreversible and would run first, a crash before
  // the txn leaves an orphaned session with NO durable intent — strictly worse.
  let workItem: WorkItem | undefined;
  try {
    workItem = createWorkItem({
      title: job.name,
      body: job.prompt,
      status: "backlog",
      source: "cron",
      sourceRef: sessionKey,
      // Slice-5 decision 7: cron-created items stamp the creating job.
      createdBy: `cron:${job.id}`,
    });
    // ICI-570: the mint happens in-process (no route emit) — signal the web now,
    // so the item appears even if the spawn below fails and no reconcile runs.
    notifyTodoChanged(workItem, "created");
  } catch (wiErr) {
    logger.warn(
      `Cron job "${job.name}" work-item mint skipped: ${wiErr instanceof Error ? wiErr.message : wiErr}`,
    );
  }

  const sendFailureAlert = async (message: string): Promise<void> => {
    const alertConnector = config.cron?.alertConnector;
    const alertChannel = config.cron?.alertChannel;
    if (!alertConnector || !alertChannel) return;
    const alertTarget = connectors.get(alertConnector);
    if (!alertTarget) return;
    await alertTarget.sendMessage(
      { channel: alertChannel },
      `⚠️ Cron job "${job.name}" failed:\n${message.slice(0, 500)}`,
    ).catch((alertErr) => {
      logger.error(`Failed to send cron alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
    });
  };

  try {
    // Org scanning lives inside the try: org/ hot-reloads, and a malformed YAML
    // mid-edit must surface as a logged job failure, not an unhandled rejection.
    let employee;
    if (job.employee) {
      employee = orgRegistry(config).get(job.employee);
    }

    const routeResult = await sessionManager.route(
      {
        connector: connector.name,
        source: "cron",
        sessionKey,
        replyContext: {
          channel: delivery?.channel || job.id,
          messageTs: null,
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
        },
        messageId: undefined,
        channel: delivery?.channel || job.id,
        thread: undefined,
        user: "system",
        userId: "system",
        text: job.prompt ?? "",
        attachments: [],
        raw: { jobId: job.id, trigger: "cron" },
        transportMeta: {
          cronJobId: job.id,
          cronJobName: job.name,
          deliveryConnector: delivery?.connector ?? null,
          deliveryChannel: delivery?.channel ?? null,
        },
      },
      connector,
      {
        employee,
        // Only the JOB's own overrides are a caller-named pick. Materializing the
        // employee and config defaults here would read as "the caller named codex"
        // and pin an engine that is out of allowance; route() resolves the same
        // defaults itself, where a spent engine can still give way to its chain.
        // The engine's configured model is not materialized either — preflight
        // resolves `session.model ?? engineConfig.model` for whichever engine runs.
        engine: job.engine || undefined,
        model: job.model || undefined,
        // A cron job's configured effort is a per-fire override; pass it as the
        // session-level effortLevel only. Do NOT merge it onto the employee,
        // otherwise an invalid job.effortLevel would clobber the employee's valid
        // default and defeat resolveEffort()'s graceful skip→employee fallback.
        effortLevel: job.effortLevel,
        title: job.name,
      },
    );

    // GRS-003b-2b — the irreversible spawn succeeded; now link the session to the
    // pre-minted work item and DERIVE its live status. `linkSession` is transactional
    // (rolls back if either row is missing) and idempotent (re-stamps the same
    // `work_item_id` on a re-fire). `reconcileWorkItem` then moves the item `backlog`→`executing`
    // from the now-linked session's real state — the reconciler (GRS-003a) is the single
    // source of truth for status, so the bridge never hardcodes it. Best-effort: a
    // link/reconcile failure must never break the actual cron job. If the process instead
    // crashed between spawn and here, the work item stays a recoverable `backlog` (reconciler
    // leaves zero-session items untouched).
    if (workItem && routeResult?.sessionId) {
      try {
        linkSession(workItem.id, routeResult.sessionId);
        reconcileWorkItem(workItem.id);
      } catch (linkErr) {
        logger.warn(
          `Cron job "${job.name}" work-item link skipped: ${linkErr instanceof Error ? linkErr.message : linkErr}`,
        );
      }
    }

    const durationMs = Date.now() - startTime;

    // ICI-1410 — `route()` resolving is not the same as the turn succeeding. A dead
    // auth chain, a rate limit, or an engine crash settles the session as failed and
    // still returns here, so the run log has to read the session's own receipt. A
    // registry hiccup must not fail a run that otherwise worked: it falls through to
    // `success`, which keeps this guard able only to turn a FALSE green red.
    let settled: Session | undefined;
    try {
      settled = (routeResult?.sessionId ? getSession(routeResult.sessionId) : undefined)
        ?? getSessionBySessionKey(sessionKey);
    } catch (lookupErr) {
      logger.warn(
        `Cron job "${job.name}" could not read its settled session: ${lookupErr instanceof Error ? lookupErr.message : lookupErr}`,
      );
    }

    const failure = settled ? sessionFailure(settled) : null;
    if (settled && failure) {
      const message = settled.lastError ?? `session ${failure}`;
      appendRunLog(job.id, {
        timestamp: startedAt,
        sessionKey,
        sessionId: routeResult?.sessionId ?? null,
        status: "error",
        durationMs,
        error: message,
      });
      opts?.emit?.("cron:run-finished", { jobId: job.id, status: "error" });
      logger.error(`Cron job "${job.name}" failed after ${durationMs}ms: ${message}`);
      await sendFailureAlert(message);
      return;
    }

    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      sessionId: routeResult?.sessionId ?? null,
      status: "success",
      durationMs,
      error: null,
    });
    opts?.emit?.("cron:run-finished", { jobId: job.id, status: "success" });
    logger.info(`Cron job "${job.name}" completed in ${durationMs}ms`);

    // Latency alert: warn if job exceeded threshold
    const thresholdMs = config.cron?.alertThresholdMs;
    if (thresholdMs && durationMs > thresholdMs) {
      const alertConnector = config.cron?.alertConnector;
      const alertChannel = config.cron?.alertChannel;
      if (alertConnector && alertChannel) {
        const alertTarget = connectors.get(alertConnector);
        if (alertTarget) {
          const mins = (durationMs / 60_000).toFixed(1);
          const threshMins = (thresholdMs / 60_000).toFixed(1);
          await alertTarget.sendMessage(
            { channel: alertChannel },
            `🐢 Cron latency alert: "${job.name}" (${job.id}) exceeded threshold — took ${mins}min (threshold: ${threshMins}min). Session: ${routeResult?.sessionId ?? "unknown"}`,
          ).catch((alertErr) => {
            logger.error(`Failed to send latency alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
          });
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      status: "error",
      durationMs: Date.now() - startTime,
      error: message,
    });
    opts?.emit?.("cron:run-finished", { jobId: job.id, status: "error" });
    logger.error(`Cron job "${job.name}" failed: ${message}`);

    await sendFailureAlert(message);
  }
}
