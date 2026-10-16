import { get, post } from "./api"

/**
 * The context meter's two calls. They live outside `lib/api.ts` because that
 * file sits on its recorded size budget (`size-baseline.json`). The shapes
 * mirror `GET /api/sessions/:id/context-usage` and `POST /api/sessions/:id/compact`
 * on the gateway — change both.
 */

export type CompactRefusalCode =
  | "busy"
  | "queued"
  | "compacting"
  | "cooldown"
  | "unsupported"
  | "no-conversation"
  | "terminal"

export interface ContextUsageWire {
  sessionId: string
  engine: string
  /** The model the session runs. */
  model: string | null
  /** Registry label for that model, when known. */
  modelLabel: string | null
  /** Null = unknown (fresh chat, just compacted without a size, engine reports none). */
  contextTokens: number | null
  /** Null = unknown. */
  contextWindow: number | null
  autoCompact: { enabled: boolean; budgetTokens: number | null }
  compact: {
    available: boolean
    /** Present iff `!available`. */
    reason?: { code: CompactRefusalCode; message: string }
    /** ISO time; only for the `cooldown` code. */
    retryAt?: string
  }
}

export interface CompactQueuedWire {
  status: "queued"
  sessionId: string
  engine: string
}

export const contextUsageApi = {
  getContextUsage: (sessionId: string) =>
    get<ContextUsageWire>(`/api/sessions/${encodeURIComponent(sessionId)}/context-usage`),
  compactSession: (sessionId: string) =>
    post<CompactQueuedWire>(`/api/sessions/${encodeURIComponent(sessionId)}/compact`),
}
