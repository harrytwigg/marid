import type { ProactiveSignal } from "./types.js";

function boundedIdentity(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 300) throw new Error(`${name} must be between 1 and 300 characters.`);
  return normalized;
}

export function proactiveEventIdentity(signal: ProactiveSignal): string {
  return boundedIdentity(signal.eventId, "eventId");
}

export function proactiveDedupeIdentity(signal: ProactiveSignal): string {
  return `${signal.source}:${boundedIdentity(signal.dedupeKey, "dedupeKey")}`;
}
