import { getSession, updateSession } from "../registry.js";
import type { JsonObject, Session } from "../../shared/types.js";

/**
 * Marker a request handler writes when a new user message arrives while a turn
 * is still running: the old turn's answer is no longer wanted, so it settles
 * quietly as interrupted instead of replying over the newer one.
 */
export const SUPERSEDED_TURN_META_KEY = "supersededRunningTurnAt";

function withTransportMeta(session: Session, updates: JsonObject): JsonObject {
  const base =
    session.transportMeta && typeof session.transportMeta === "object" && !Array.isArray(session.transportMeta)
      ? session.transportMeta
      : {};
  return { ...base, ...updates };
}

/** Write the marker: a newer user intent has displaced this session's live turn. */
export function supersedeRunningTurn(session: Session): void {
  updateSession(session.id, {
    transportMeta: withTransportMeta(session, {
      [SUPERSEDED_TURN_META_KEY]: new Date().toISOString(),
    }),
  });
}

export function clearSupersededTurnMeta(sessionId: string): void {
  const session = getSession(sessionId);
  const meta = session?.transportMeta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !(SUPERSEDED_TURN_META_KEY in meta)) return;
  const next = { ...meta };
  delete next[SUPERSEDED_TURN_META_KEY];
  updateSession(sessionId, { transportMeta: next });
}

export function isTurnSuperseded(sessionId: string, turnStartedAt: number): boolean {
  const marker = getSession(sessionId)?.transportMeta?.[SUPERSEDED_TURN_META_KEY];
  if (typeof marker !== "string") return false;
  const markedAt = new Date(marker).getTime();
  return Number.isFinite(markedAt) && markedAt >= turnStartedAt;
}

/**
 * Prompts a newer user message displaced before the engine had begun their
 * turn. The engine never recorded them, so the next turn carries them forward;
 * without this they are lost from the engine's context entirely.
 */
export const UNSEEN_INTERRUPTED_PROMPTS_META_KEY = "unseenInterruptedPrompts";

/** Past this many pile-ups the sender is a stuck client, not a fast typist. */
const MAX_UNSEEN_INTERRUPTED_PROMPTS = 5;

/** Hold an interrupted prompt the engine never read, for the next turn to carry. */
export function retainUnseenInterruptedPrompt(sessionId: string, prompt: string): void {
  const text = prompt.trim();
  const session = getSession(sessionId);
  if (!text || !session) return;
  const pending = [...readUnseenInterruptedPrompts(session), text].slice(-MAX_UNSEEN_INTERRUPTED_PROMPTS);
  updateSession(sessionId, {
    transportMeta: withTransportMeta(session, { [UNSEEN_INTERRUPTED_PROMPTS_META_KEY]: pending }),
  });
}

/** The interrupted prompts still owed to the engine, oldest first. */
export function readUnseenInterruptedPrompts(session: Session): string[] {
  const held = session.transportMeta?.[UNSEEN_INTERRUPTED_PROMPTS_META_KEY];
  if (!Array.isArray(held)) return [];
  return held.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** Drop the held prompts a turn has now put in front of the engine. */
export function withUnseenInterruptedPromptsCleared(meta: unknown): Record<string, unknown> {
  const base = meta && typeof meta === "object" && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
  delete base[UNSEEN_INTERRUPTED_PROMPTS_META_KEY];
  return base;
}
