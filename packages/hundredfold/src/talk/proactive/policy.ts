import type { ProactiveDecision, ProactivePolicyContext, ProactiveSignal } from "./types.js";

export const PROACTIVE_SPOKEN_COOLDOWN_MS = 30_000;
export const PROACTIVE_MAX_EVENT_AGE_MS = 5 * 60_000;

function urgent(signal: ProactiveSignal): boolean {
  return signal.severity === "critical" || signal.blocking || signal.requiresOperator;
}

function ignoredDecision(
  signal: ProactiveSignal,
  context: ProactivePolicyContext,
  urgency: ProactiveDecision["urgency"],
): ProactiveDecision | null {
  if (signal.occurredAt < context.now - PROACTIVE_MAX_EVENT_AGE_MS) {
    return { disposition: "ignore", urgency, reason: "stale" };
  }
  if (signal.source === "employee" && signal.topicId === null) {
    return { disposition: "ignore", urgency, reason: "employee-noise" };
  }
  if (signal.topicId === null || !context.knownTopicIds.includes(signal.topicId)) {
    return { disposition: "ignore", urgency, reason: "unrelated-topic" };
  }
  return null;
}

export function decideProactiveDisposition(
  signal: ProactiveSignal,
  context: ProactivePolicyContext,
): ProactiveDecision {
  const urgency = urgent(signal) ? "urgent" : "routine";
  const ignored = ignoredDecision(signal, context, urgency);
  if (ignored) return ignored;
  if (urgency === "routine") return { disposition: "quiet", urgency, reason: "relevant-routine" };
  if (signal.topicId !== context.activeTopicId) {
    return { disposition: "quiet", urgency, reason: "urgent-background-topic" };
  }
  const inCooldown = context.lastSpokenAt !== null
    && context.lastSpokenAt > context.now - PROACTIVE_SPOKEN_COOLDOWN_MS;
  return inCooldown
    ? { disposition: "quiet", urgency, reason: "spoken-cooldown" }
    : { disposition: "spoken", urgency, reason: "urgent-active-topic" };
}
