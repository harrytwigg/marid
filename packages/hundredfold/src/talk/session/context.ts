/**
 * Rolling context management for a talk session.
 *
 * A realtime conversation has no compaction step: everything the model has heard
 * stays in its context and is re-billed on every turn. So the gateway keeps its
 * own estimate and drops the oldest turns once the estimate passes a budget.
 */
import type { TalkTurnRecord } from "./types.js";

/** Where truncation starts. Roughly a long conversation, well under any
 *  provider's window — the budget exists to bound cost, not to avoid an error. */
export const TALK_CONTEXT_BUDGET_TOKENS = 6000;

/** A single turn this large is a research request wearing a conversation's
 *  clothes; the orb offers a text session instead of answering it out loud. */
export const TALK_HANDOFF_TURN_TOKENS = 1500;

/** Four characters per token. A documented estimate, not the provider's count —
 *  the real numbers arrive with each turn's usage and are what gets billed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contextTokens(turns: readonly TalkTurnRecord[]): number {
  return turns.reduce((total, turn) => total + turn.estimatedTokens, 0);
}

export interface TruncationResult {
  turns: TalkTurnRecord[];
  /** How many turns this call dropped. */
  dropped: number;
}

/**
 * Drop oldest turns until the estimate fits the budget. The newest turn is
 * always kept, even when it exceeds the budget on its own: a session with
 * nothing in context cannot answer the thing the user just said. That case is
 * what `handoffSuggested` is for.
 */
export function truncateTurns(turns: readonly TalkTurnRecord[], budgetTokens: number): TruncationResult {
  const kept = [...turns];
  let dropped = 0;
  while (kept.length > 1 && contextTokens(kept) > budgetTokens) {
    kept.shift();
    dropped += 1;
  }
  return { turns: kept, dropped };
}

/** Whether this turn is heavy enough to be worth moving to a text session. */
export function handoffSuggested(turn: TalkTurnRecord): boolean {
  return turn.estimatedTokens > TALK_HANDOFF_TURN_TOKENS;
}
