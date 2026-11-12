// The payloads the fake Claude hands the gateway, in the shapes the real CLI sends them.
//
// Hook payloads are what `engines/claude-interactive.ts` reads: the common fields on every
// event, and on a StopFailure the `error` enum (`rate_limit`, `authentication_failed`, …)
// and `error_details`. The statusline payload is what the gateway's recorder file keeps and
// `shared/engine-reset-times.ts` reads a reset from: `rate_limits.five_hour.resets_at`, in
// epoch seconds, since the StopFailure itself never carries one.

/** The fields every hook event carries. */
export function hookPayload(event, base, extra = {}) {
  return {
    session_id: base.sessionId,
    transcript_path: base.transcriptPath,
    cwd: base.cwd,
    hook_event_name: event,
    ...extra,
  };
}

/** The StopFailure the CLI sends when the API refuses a turn with `error`. */
export function stopFailurePayload(base, error, details, lastMessage) {
  return hookPayload("StopFailure", base, {
    error,
    error_details: details,
    last_assistant_message: lastMessage,
  });
}

/** What the CLI hands its statusline command: the model, and the account's windows. */
export function statusLinePayload({ sessionId, model, usedPercentage, resetsAt }) {
  const window = (used, resets) => ({ used_percentage: used, resets_at: resets });
  return {
    session_id: sessionId,
    version: "2.1.300",
    model: { id: model || "claude-fake", display_name: model || "Fake" },
    rate_limits: {
      five_hour: window(usedPercentage, resetsAt),
      seven_day: window(Math.min(usedPercentage, 40), resetsAt + 6 * 24 * 3600),
    },
    cost: { total_cost_usd: 0 },
  };
}

/** The error text a rate-limited turn leaves in the transcript, as the CLI words it. */
export function rateLimitMessage(resetsAt) {
  return `You've hit your limit · resets ${new Date(resetsAt * 1000).toISOString()}`;
}

/** A transcript line for one message, shaped like the CLI's own. */
export function transcriptEntry(role, text, { sessionId, cwd, model, uuid, error = false }) {
  const message = role === "user"
    ? { role, content: text }
    : {
        id: `msg_${uuid}`,
        type: "message",
        role,
        model: error ? "<synthetic>" : model || "claude-fake",
        content: [{ type: "text", text }],
        stop_reason: error ? "stop_sequence" : "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
  return {
    type: role,
    message,
    uuid,
    sessionId,
    cwd,
    version: "2.1.300",
    timestamp: new Date().toISOString(),
    ...(error ? { isApiErrorMessage: true } : {}),
  };
}

/** The `compact_boundary` system entry Claude Code appends when a `/compact` finishes. */
export function compactBoundaryEntry({ sessionId, cwd, uuid, preTokens, postTokens }) {
  return {
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    compactMetadata: { trigger: "manual", preTokens, postTokens },
    uuid,
    sessionId,
    cwd,
    version: "2.1.300",
    timestamp: new Date().toISOString(),
  };
}

/** The opening sentence of the summary Claude Code writes after a boundary (what `isCompactSummary` marks). */
export const COMPACT_SUMMARY_OPENING = "This session is being continued from a previous conversation that ran out of context.";

/** The user entry holding the summary, marked `isCompactSummary` as the CLI marks it. `parts` gives array content instead of a string. */
export function compactSummaryEntry(text, { sessionId, cwd, uuid, parts = false }) {
  return {
    type: "user",
    message: { role: "user", content: parts ? [{ type: "text", text }] : text },
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    uuid,
    sessionId,
    cwd,
    version: "2.1.300",
    timestamp: new Date().toISOString(),
  };
}

/** The plain user entries a manual `/compact` writes around its boundary (not summaries). */
export function compactCommandEntries(args, { sessionId, cwd }) {
  const entry = (content) => ({
    type: "user",
    message: { role: "user", content },
    uuid: `fake-${Math.random().toString(36).slice(2)}`,
    sessionId,
    cwd,
    version: "2.1.300",
    timestamp: new Date().toISOString(),
  });
  return [entry(`<command-name>/compact</command-name>\n<command-args>${args}</command-args>`), entry("<local-command-stdout>Compacted</local-command-stdout>")];
}
