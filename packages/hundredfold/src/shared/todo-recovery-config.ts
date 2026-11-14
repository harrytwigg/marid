const TODO_RECOVERY_MODES = new Set(["off", "classify-only", "auto"]);

/** Shape-check `gateway.todoRecovery`. Unset is valid (runtime default classify-only). */
export function todoRecoveryProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["gateway.todoRecovery must be a mapping"];
  }
  const mode = (value as { mode?: unknown }).mode;
  if (mode === undefined || (typeof mode === "string" && TODO_RECOVERY_MODES.has(mode))) return [];
  return [`gateway.todoRecovery.mode must be off, classify-only, or auto (got ${JSON.stringify(mode)})`];
}
