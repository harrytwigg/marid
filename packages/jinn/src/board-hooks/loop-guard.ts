import { getSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import { chainOfFire } from "./run-store.js";
import { MAX_HOOK_CHAIN } from "./types.js";

/** Ancestor levels walked when looking for a hook session. */
const MAX_ANCESTOR_DEPTH = 10;
const HOOK_SOURCE = "hook";
const HOOK_REF_PREFIX = "hook:";

/** The chain a hook session's fire recorded; a missing run row (pruned, or never written) leaves the guard open, so say so. */
function chainOfSession(sessionId: string, sourceRef: string): string[] {
  const chain = chainOfFire(sourceRef.replace(HOOK_REF_PREFIX, ""));
  if (chain.length === 0) logger.warn(`board hooks: no run row for hook session ${sessionId} (${sourceRef}); its events are not loop-guarded`);
  return chain;
}

/** The chain of every hook session on the path from `sessionId` up through its parents, oldest hook first. */
function chainsAbove(sessionId: string): string[][] {
  const chains: string[][] = [];
  const seen = new Set<string>();
  let id: string | null = sessionId;
  for (let depth = 0; id && depth < MAX_ANCESTOR_DEPTH && !seen.has(id); depth += 1) {
    seen.add(id);
    const session = getSession(id);
    if (!session) break;
    if (session.source === HOOK_SOURCE) chains.unshift(chainOfSession(session.id, session.sourceRef));
    id = session.parentSessionId;
  }
  return chains;
}

/**
 * The hooks upstream of a board event: when its actor is a session, the union of
 * the chains stored for the hook-spawned sessions among that session and its
 * ancestors. Empty when a person or an ordinary session did it.
 */
export function eventChain(actorSessionId: string | undefined): string[] {
  if (!actorSessionId) return [];
  const [first = [], ...rest] = chainsAbove(actorSessionId);
  const merged = [...first];
  for (const chain of rest) for (const name of chain) if (!merged.includes(name)) merged.push(name);
  return merged;
}

/** Why a hook may not fire on an event with this chain, or null when it may. */
export function suppressionReason(hook: { name: string; allowReentry?: boolean }, chain: readonly string[]): string | null {
  if (chain.length >= MAX_HOOK_CHAIN) {
    return `the hook chain already holds ${chain.length} hooks (${chain.join(" -> ")}); the limit is ${MAX_HOOK_CHAIN}`;
  }
  if (chain.includes(hook.name) && !hook.allowReentry) {
    return `hook "${hook.name}" is already in this event's chain (${chain.join(" -> ")}) and allowReentry is not set`;
  }
  return null;
}
