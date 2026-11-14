/** Field readers for grok's loosely-typed JSON lines. Every grok surface — the
 *  headless stream, the PTY transcript, the on-disk session files — carries the
 *  same shapes with optional, renamed and nested fields, so pulling a value out
 *  of one is its own concern, kept apart from deciding what a line MEANS.
 *  Extracted from grok.ts; the bodies are unchanged. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isReasoningType(value: unknown): boolean {
  const type = String(value ?? "").toLowerCase();
  return type.includes("thought") || type.includes("thinking") || type.includes("reasoning") || type.includes("chain_of_thought");
}

export function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function stripReasoningMarkup(text: string): string {
  return text
    .replace(/<\s*(thinking|reasoning|thought)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
}

export function compactText(text: string, max = 500): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function safeJsonSnippet(value: unknown, max = 200): string | undefined {
  if (value === undefined) return undefined;
  try {
    return compactText(JSON.stringify(value), max);
  } catch {
    return undefined;
  }
}

function normalizeGrokToolName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  }
  return name;
}

export function toolNameFromGrokUpdate(update: Record<string, unknown>): string | undefined {
  const rawInput = asRecord(update.rawInput);
  const rawOutput = asRecord(update.rawOutput);
  return normalizeGrokToolName(
    stringField(rawInput ?? {}, ["variant", "tool", "toolName", "name"]) ??
    stringField(rawOutput ?? {}, ["type", "variant", "tool", "toolName", "name"]) ??
    stringField(update, ["toolName", "tool_name", "name", "title", "kind"]),
  );
}

export function planStatusFromGrokUpdate(update: Record<string, unknown>): string | undefined {
  const entries = Array.isArray(update.entries) ? update.entries : [];
  const parsed = entries
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const active =
    parsed.find((entry) => String(entry.status ?? "").toLowerCase() === "in_progress") ??
    parsed.find((entry) => String(entry.status ?? "").toLowerCase() === "pending") ??
    parsed[parsed.length - 1];
  const text = active ? stringField(active, ["content", "title", "task"]) : undefined;
  return text ? `Plan: ${compactText(text, 240)}` : undefined;
}

export function extractError(obj: Record<string, unknown>): string | undefined {
  const err = obj.error;
  if (typeof err === "string" && err.trim()) return err;
  const errObj = asRecord(err);
  if (errObj) {
    const msg = stringField(errObj, ["message", "error", "detail"]);
    if (msg) return msg;
  }
  return stringField(obj, ["errorMessage", "message", "detail"]);
}
