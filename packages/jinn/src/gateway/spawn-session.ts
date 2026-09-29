import { logger } from "../shared/logger.js";
import type { JinnConfig, Session } from "../shared/types.js";
import { createSession, insertMessage, updateSession, enqueueQueueItem } from "../sessions/registry.js";
import { validateNewSessionSelection } from "../sessions/session-patch.js";
import { fileIdsToMedia, rehomeAttachmentsToSession } from "./files.js";
import { resolveMessageAudiences, speechContextApplies } from "./speech-context.js";
import { isRawEngineCommand } from "../shared/skill-commands.js";
import { dispatchWebSessionRun, resolveAttachmentPaths } from "./web-session-dispatch.js";
import type { ApiContext } from "./api.js";

/**
 * Spawning a session, with nothing about HTTP in it.
 *
 * `POST /api/sessions` was the only way to start one, so a second caller — the
 * plugin host's `sessions.spawn` — would have had to reimplement employee
 * resolution, engine/model validation, the first message, the queue item and
 * the dispatch, and would have got one of them subtly wrong. The route keeps
 * what only a request can decide (who is asking, whose child this is, which
 * uploads came with it) and hands the rest here.
 */

/** Where a spawn came from, as the row records it. The default is the dashboard;
 *  a plugin passes its own so a session it started is attributable afterwards. */
export interface SpawnProvenance {
  source: string;
  sourceRef: string;
}

export interface SpawnSessionInput {
  prompt: string;
  /** Already coerced against the portal name by the caller, because whether a
   *  name is a pseudo-employee depends on config the caller has read. */
  employee?: string | null;
  engine?: unknown;
  model?: unknown;
  effortLevel?: unknown;
  parentSessionId?: string;
  promptExcerpt?: string;
  userId?: string;
  /** Uploaded file ids, as the web route receives them. */
  attachments?: unknown;
  /** Paste the prompt into the engine's PTY view when it has one. */
  interactive?: boolean;
  /** The prompt came from speech, so the engine hears a hidden context note the
   *  persisted and queued text never carries. */
  speech?: boolean;
  provenance?: SpawnProvenance;
}

/**
 * A refusal, or the session that now exists.
 *
 * `dispatched: false` is not a failure: the session was created and persisted
 * with its error on it, which is what the route has always answered 201 with.
 * Collapsing that into an error would change what an existing caller sees.
 */
export type SpawnSessionOutcome =
  | { ok: false; error: string }
  | { ok: true; session: Session; dispatched: boolean };

function defaultProvenance(): SpawnProvenance {
  const sessionKey = `web:${Date.now()}`;
  return { source: "web", sourceRef: sessionKey };
}

/** The engine, model and effort a spawn resolves to, or why it cannot. An
 *  employee that no longer resolves fails closed rather than quietly becoming a
 *  gateway-default session. */
type SpawnSelection =
  | { ok: false; error: string }
  | { ok: true; engineName: string; model?: string; effortLevel?: string };

async function resolveSelection(
  config: JinnConfig,
  input: SpawnSessionInput,
  employeeName: string | null,
): Promise<SpawnSelection> {
  let employeeDefaults: { engine: string; model: string; effortLevel?: string; employee?: string } | undefined;
  if (employeeName) {
    const { orgRegistry } = await import("./org-registry.js");
    const emp = orgRegistry(config).get(employeeName);
    // A transient org-registry/file-watcher miss must not silently turn an
    // employee spawn into a gateway-default session. Resolve the employee
    // first or fail closed, matching the delegation route.
    if (!emp) return { ok: false, error: `unknown employee "${employeeName}" — GET /api/org lists valid employees` };
    // GRS-017f: carry the employee slug so an unregistered configured
    // model produces the same actionable, employee-named error the
    // delegation route surfaces (not a cryptic bare-engine string).
    employeeDefaults = { engine: emp.engine, model: emp.model, employee: employeeName };
    if (emp.effortLevel) employeeDefaults.effortLevel = emp.effortLevel;
  }
  const selection = validateNewSessionSelection(config, {
    engine: input.engine,
    model: input.model,
    effortLevel: input.effortLevel,
  }, employeeDefaults);
  if (!selection.ok) return { ok: false, error: selection.error || "invalid engine/model/effort" };
  return {
    ok: true,
    engineName: selection.engine || config.engines.default,
    model: selection.model,
    effortLevel: selection.effortLevel,
  };
}

/**
 * Mark the session running, queue its first turn and dispatch it.
 *
 * Split from the creation above because the two fail differently: nothing here
 * can refuse the spawn, and everything here has a persisted row to attach its
 * outcome to.
 */
function startFirstTurn(
  context: ApiContext,
  session: Session,
  input: SpawnSessionInput,
  engineName: string,
): SpawnSessionOutcome {
  // Run engine asynchronously — respond immediately, push result via WebSocket.
  // CLI-mode session creation uses the engine's PTY view when one exists
  // (Claude, Antigravity). Engines without a PTY view fall back to normal chat.
  const ptyEngine = input.interactive ? context.ptyViewEngines?.[engineName] : undefined;
  const engine = ptyEngine ?? context.sessionManager.getEngine(engineName);
  if (!engine) {
    const lastError = `Engine "${engineName}" not available`;
    updateSession(session.id, { status: "error", lastError });
    return { ok: true, session: { ...session, status: "error", lastError }, dispatched: false };
  }

  // Set status to "running" synchronously BEFORE returning. This prevents a
  // race condition where the caller polls immediately and sees "idle" status
  // before the turn has a chance to set "running".
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
  session.status = "running";

  const attachmentPaths = resolveAttachmentPaths(input.attachments);
  const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
  const queueItemId = enqueueQueueItem(session.id, queueSessionKey, input.prompt);
  context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });

  // Speech-derived first messages carry a hidden context note to the engine
  // only; the persisted and queued prompt stays the operator's exact text.
  // Interactive dispatch pastes the prompt into the visible PTY, so the note is
  // suppressed there (ptyEngine truthy) and only rides headless dispatch.
  const { engine: enginePrompt } = resolveMessageAudiences(
    input.prompt,
    speechContextApplies({
      speech: input.speech === true,
      isNotification: false,
      promptRendered: !!ptyEngine,
      rawEngineCommand: isRawEngineCommand(session.engine, input.prompt),
    }),
  );

  dispatchWebSessionRun(session, enginePrompt, engine, context, {
    queueItemId,
    attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
  });

  return { ok: true, session, dispatched: true };
}

export async function spawnSession(
  context: ApiContext,
  input: SpawnSessionInput,
): Promise<SpawnSessionOutcome> {
  const config = context.getConfig();
  const employeeName = input.employee ?? null;
  const selection = await resolveSelection(config, input, employeeName);
  if (!selection.ok) return selection;

  const provenance = input.provenance ?? defaultProvenance();
  const session = createSession({
    engine: selection.engineName,
    source: provenance.source,
    sourceRef: provenance.sourceRef,
    // The transport a reply surfaces on, which is the dashboard however the
    // spawn was asked for — a plugin has no channel of its own to answer to.
    connector: "web",
    sessionKey: provenance.sourceRef,
    replyContext: { source: "web" },
    userId: input.userId,
    // A session tagged with the portal name is a direct/COO session, not a
    // pseudo-employee (there is no org employee by the portal's name).
    // Coerce it to null so it buckets into the direct group rather than
    // spawning a phantom group that renders with the portal's own title.
    employee: employeeName,
    parentSessionId: input.parentSessionId,
    effortLevel: selection.effortLevel,
    // Honor the requested model so API clients can pin per-employee models
    // (e.g. MCP servers that look up org/<employee>.yaml and pass the
    // employee's configured model). Without this, the turn falls back to
    // config.engines.claude.model, breaking per-employee routing. Fixes #38.
    model: selection.model,
    prompt: input.prompt,
    // Optional excerpt override (callers that wrap the operator's ask in a
    // scaffolded prompt pass the verbatim ask so list UIs show that instead).
    promptExcerpt: input.promptExcerpt,
    portalName: config.portal?.portalName,
  });
  logger.info(`Web session created: ${session.id} (model=${selection.model || "default"})`);
  // First-message attachments were uploaded before the session existed (FILES_DIR).
  // Re-home them under uploads/<date>/<sessionId>/ now that we have an id, then persist
  // the media on the user message so the bubble renders chips/thumbnails on reload.
  rehomeAttachmentsToSession(input.attachments, session.id);
  const newSessionMedia = fileIdsToMedia(input.attachments);
  insertMessage(session.id, "user", input.prompt, newSessionMedia.length > 0 ? newSessionMedia : undefined);

  return startFirstTurn(context, session, input, selection.engineName);
}
