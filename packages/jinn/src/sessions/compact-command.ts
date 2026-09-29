import type { CompactionStats } from "../shared/types.js";
import { compactionUnsupported, SELF_COMPACTION_ENGINES, SELF_COMPACTION_FOCUS_PREFIX } from "./self-compaction.js";

/**
 * `/compact` typed by the operator — in the web chat, the CLI view's composer or
 * a connector — as opposed to the compact_session a session asks for itself
 * (`self-compaction.ts`). Both run the same compaction turn; this module is only
 * what the operator is told about it.
 *
 * The routing is engine-agnostic by construction: the turn preflight decides
 * whether this session's engine can compact at all, and only a turn that can
 * ever reaches an engine. Each engine then runs its OWN compaction — Claude
 * Code's native `/compact` (with any focus instructions after it), opencode's
 * `session.summarize` — and an engine with none is answered here instead of
 * being handed "/compact" as text to reply to.
 */

/** The live status line while the compaction turn runs. */
export const COMPACT_STARTED_STATUS = "🗜️ Compacting context…";

/**
 * Why this `/compact` cannot run, in the operator's terms, or undefined when it
 * can. `hasEngineSession` is whether the engine has a conversation of this
 * session's to compact at all: a brand-new chat, or one that has just switched
 * engines, has none yet.
 */
export function compactCommandRefusal(
  engine: string,
  opencodeMode: string | undefined,
  hasEngineSession: boolean,
): string | undefined {
  const unsupported = compactionUnsupported(engine, opencodeMode);
  if (unsupported === "opencode-run-mode") {
    return "`/compact` isn't available here: opencode can only compact in server mode (`engines.opencode.mode: server`), "
      + "and this instance runs `opencode run`, which has no compaction Jinn can call. Nothing was sent to the model.";
  }
  if (unsupported === "no-native-compaction") {
    return `\`/compact\` isn't supported on the ${engine} engine: Jinn can only drive the native compaction of `
      + `${SELF_COMPACTION_ENGINES.join(" and ")}. Nothing was sent to the model.`;
  }
  if (!hasEngineSession) {
    return `Nothing to compact yet: this session has no ${engine} conversation to compact.`;
  }
  return undefined;
}

/** "12.3k tokens" — a context size as the meter shows it. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  const thousands = tokens / 1000;
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k tokens`;
}

const positive = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** A compaction turn that ended cleanly without the engine ever saying it
 *  compacted — Claude Code settled on the quiet-window backstop without a
 *  PostCompact, say. Claiming success then would be a guess. */
export const COMPACTION_UNCONFIRMED =
  "⚠️ `/compact` finished, but the engine never confirmed a compaction, so the context may be unchanged. "
  + "The CLI view shows what the engine did.";

/** A `/compact` the engine refused with a usage limit. It is not retried and
 *  not moved to a fallback engine, so nothing was compacted. */
export function compactionRateLimited(engineLabel: string, resetsAt: string | null): string {
  return `⏳ ${engineLabel} is at its usage limit${resetsAt ? ` (resets ${resetsAt})` : ""}, so \`/compact\` was not run `
    + `and the session stays on ${engineLabel}. Send it again once the limit lifts.`;
}

/** What the operator sees once the compaction is done. */
export function compactionConfirmation(stats: CompactionStats | undefined): string {
  const pre = positive(stats?.preTokens) ? stats!.preTokens : undefined;
  const post = positive(stats?.postTokens) ? stats!.postTokens : undefined;
  if (pre !== undefined && post !== undefined) {
    return `🗜️ Context compacted: ${formatTokens(pre)} → ${formatTokens(post)}.`;
  }
  if (pre !== undefined) return `🗜️ Context compacted (it was ${formatTokens(pre)}).`;
  return "🗜️ Context compacted.";
}

/**
 * What the operator is told about the text after `/compact`, if anything.
 * Claude Code summarizes with it; opencode's summarize takes none, so an
 * operator who wrote some should know it went unused. A self-compaction's own
 * focus is not mentioned: its handoff is re-delivered after the compaction.
 */
export function unusedFocusNote(engine: string, prompt: string): string | undefined {
  if (engine !== "opencode") return undefined;
  const focus = prompt.trimStart().replace(/^\/compact/, "").trim();
  if (!focus || focus.startsWith(SELF_COMPACTION_FOCUS_PREFIX)) return undefined;
  return "opencode's summarize takes no focus instructions, so the text after `/compact` was not used.";
}
