/**
 * The `transportMeta` keys that make a turn's first prompt carry a catch-up for a
 * conversation that missed something, and the one switch that decides how: a
 * pasted transcript (every writer but a deliberate switch) or a pointer to where
 * the history can be read (`engineSyncMode: "pointer"`, written by `switchSessionTarget`).
 * A leaf module: the registry, the prompt resolver and the override revert all read it.
 */

/** Set when an engine reports it no longer has the conversation; its value is the engine that lost it. */
export const LOST_CONVERSATION_META_KEY = "lostConversationEngine";

/** `meta.kind` of the chat notice that says an engine conversation could not be resumed. It is for the operator: the replacement conversation is told so in its own prompt, so the notice is left out of the transcript it is handed. */
export const LOST_CONVERSATION_NOTICE_KIND = "lost-conversation";

/** The catch-up mode of a pending engine-sync marker: `"pointer"`, or absent for the pasted transcript. */
export const SYNC_MODE_META_KEY = "engineSyncMode";

/** Every marker that can pre-empt or redirect the next prompt's catch-up, except the lost-conversation key. */
const CATCH_UP_KEYS = ["claudeSyncSince", "claudeSyncAccount", "engineSyncTarget", "engineSyncSince", SYNC_MODE_META_KEY] as const;

/** `meta` with every catch-up marker (and, unless kept, the lost-conversation key) removed. */
export function withoutCatchUpMarkers(meta: Record<string, unknown>, opts: { keepLostConversation?: boolean } = {}): Record<string, unknown> {
  const next = { ...meta };
  for (const key of CATCH_UP_KEYS) delete next[key];
  if (!opts.keepLostConversation) delete next[LOST_CONVERSATION_META_KEY];
  return next;
}
