import type { HundredfoldConfig, Session } from "../shared/types.js";
import type { PendingSwitch } from "./pending-switch.js";
import type { CompactionHandoff } from "./self-compaction.js";
import { compactionUnsupported } from "./self-compaction.js";
import {
  describeSwitchTarget, listSwitchTargets, ownSwitchTarget, staysInSlot,
  type SwitchRequest, type SwitchResolution, type SwitchTargetEngine, type SwitchTargetList, type SwitchTargetView,
} from "./switch-target.js";

/**
 * The session's own switch, as `POST /api/compactions` reads it (contracts §2): which body
 * fields name a target, what a refused target answers (the reason and the list of valid
 * targets, rendered into `error` because the MCP wrapper passes `error` through and drops other
 * keys), and the pending switch a scheduled request leaves for the resume turn.
 */

/** The body's target fields, or undefined when it names none (a plain compaction). A `sessionId` in the body is never read. */
export function switchRequestOf(body: unknown): SwitchRequest | undefined {
  const raw = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (raw.engine === undefined && raw.profile === undefined && raw.model === undefined) return undefined;
  return { engine: raw.engine, profile: raw.profile, model: raw.model };
}

/** The whole refusal text, list included, stays under this: the tool error carries it as one string. */
export const REFUSAL_ERROR_MAX_CHARS = 1_800;

const LIST_INTRO = "call again with one of these";

function untilText(iso: string): string {
  return `${iso.slice(0, 16)}Z`;
}

function healthNote(health: SwitchTargetEngine["health"]): string {
  return health.state === "exhausted" ? ` (exhausted${health.until ? ` until ${untilText(health.until)}` : ""})` : "";
}

/** The engine's profiles as `"" (own login), work (exhausted until …)`, or none for an engine without. */
function profilesText(engine: SwitchTargetEngine): string {
  if (!engine.profiles) return "";
  const rows = engine.profiles.map((profile) => `${profile.name === "" ? "\"\"" : profile.name}${profile.name === "" ? ` (${profile.label})` : ""}${healthNote(profile.health)}`);
  return `profiles ${rows.join(", ")}; `;
}

/** One engine's line, with as many of its models as fit in `budget` characters and the rest counted. */
function engineLine(engine: SwitchTargetEngine, budget: number): string {
  const head = `${engine.name}${engine.profiles ? "" : healthNote(engine.health)}: ${profilesText(engine)}`;
  const ids = engine.models.map((model) => model.id);
  if (ids.length === 0) return `${head}no listed models.`;
  const whole = `${head}models ${ids.join(", ")}.`;
  if (whole.length <= budget) return whole;
  const more = (shown: number) => `${ids.slice(0, shown).join(", ")}${shown > 0 ? ", " : ""}… +${ids.length - shown} more (call with engine "${engine.name}", model "?" for its list).`;
  for (let shown = ids.length - 1; shown > 0; shown--) {
    const line = `${head}models ${more(shown)}`;
    if (line.length <= budget) return line;
  }
  return `${head}models ${more(0)}`;
}

/** The lines for `engines`, each given its share of `budget` (a short engine keeps what it needs; the rest is split among the longer). */
function engineLines(engines: SwitchTargetEngine[], budget: number): string[] {
  const full = engines.map((engine) => engineLine(engine, Number.MAX_SAFE_INTEGER));
  const order = engines.map((_, index) => index).sort((a, b) => full[a].length - full[b].length);
  const lines: string[] = [];
  let remaining = budget;
  order.forEach((index, rank) => {
    const share = Math.floor(remaining / (order.length - rank)) - 1;
    lines[index] = full[index].length <= share ? full[index] : engineLine(engines[index], Math.max(share, 0));
    remaining -= lines[index].length + 1;
  });
  return lines;
}

/**
 * The refusal's `error`: the reason, where the session stands now, and the valid targets, in
 * at most {@link REFUSAL_ERROR_MAX_CHARS} characters. A call that names an engine with
 * `model: "?"` lists only that engine, so a long catalogue can be read in full.
 */
export function renderRefusal(config: HundredfoldConfig, session: Session, reason: string, list: SwitchTargetList, request: SwitchRequest & { listEngine?: string }): string {
  const onlyName = request.listEngine ?? (request.model === "?" && typeof request.engine === "string" ? request.engine.trim() : undefined);
  const only = onlyName ? list.engines.filter((engine) => engine.name === onlyName) : [];
  const shown = only.length > 0 ? only : list.engines;
  const intro = `${reason} — ${LIST_INTRO}. Now: ${describeSwitchTarget(config, ownSwitchTarget(config, session))}.`;
  const text = [intro, ...engineLines(shown, REFUSAL_ERROR_MAX_CHARS - intro.length - 1)].join("\n");
  return text.length <= REFUSAL_ERROR_MAX_CHARS ? text : `${text.slice(0, REFUSAL_ERROR_MAX_CHARS - 1)}…`;
}

/** A target refusal's status and body: its code, the rendered text, the structured list, and (an exhausted target) when the window ends. */
export function switchRefusalBody(
  config: HundredfoldConfig,
  session: Session,
  refused: Extract<SwitchResolution, { ok: false }>,
  request: SwitchRequest,
): { status: number; body: Record<string, unknown> } {
  const targets = listSwitchTargets(config, session);
  return {
    status: refused.status,
    body: {
      code: refused.code,
      error: renderRefusal(config, session, refused.error, targets, { ...request, listEngine: refused.listEngine }),
      ...(refused.until ? { until: refused.until } : {}),
      targets,
    },
  };
}

/** What `switch` says of a view on the 202. */
function viewOf(view: SwitchTargetView): { engine: string; profile: string | null; model: string | null } {
  return { engine: view.engine, profile: view.profile, model: view.model };
}

/** Whether the engine the compaction would run on has one Hundredfold can drive (opencode only in server mode). */
export function compactsNatively(session: Session, opencodeMode: string | undefined): boolean {
  return compactionUnsupported(session.engine, opencodeMode) === undefined;
}

/**
 * The record a scheduled request leaves for its resume turn: a conversation continued in place only
 * when the engine compacts, the target stays in its slot, and no stand-in holds the session (the
 * compaction would run on the stand-in's thread, while the apply returns to the original one).
 */
export function buildPendingSwitch(
  config: HundredfoldConfig,
  session: Session,
  resolved: Extract<SwitchResolution, { ok: true }>,
  { claimedAt, handoff, opencodeMode }: { claimedAt: number; handoff: CompactionHandoff; opencodeMode: string | undefined },
): PendingSwitch {
  const compactionQueued = compactsNatively(session, opencodeMode);
  return {
    claimedAt,
    from: resolved.own,
    to: resolved.target,
    conversation: compactionQueued && !session.transportMeta?.engineOverride && staysInSlot(config, session, resolved.target) ? "same" : "new",
    compactedOn: session.engine,
    compactionQueued,
    handoff,
  };
}

/** The `switch` member of the 202 body. */
export function scheduledSwitchBody(pending: PendingSwitch): Record<string, unknown> {
  return {
    from: viewOf(pending.from),
    to: viewOf(pending.to),
    conversation: pending.conversation,
    compaction: pending.compactionQueued ? "queued" : "skipped",
  };
}
