const MAX_SESSION_KEY_CHARS = 256;
const SAFE_CRON_SESSION_KEY_RE = /^cron:[a-z0-9_.:-]{1,180}:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CRON_RUN_STATUSES = new Set(["success", "error"]);

function safeSessionKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > MAX_SESSION_KEY_CHARS) return undefined;
  return SAFE_CRON_SESSION_KEY_RE.test(value) ? value : undefined;
}

function safeSessionId(value: unknown): string | undefined {
  // The runner writes `null` for a fire that never spawned a session.
  if (typeof value !== "string") return undefined;
  return SAFE_UUID_RE.test(value) ? value : undefined;
}

function safeStatus(value: unknown): string | undefined {
  return typeof value === "string" && CRON_RUN_STATUSES.has(value) ? value : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeTimestamp(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (value.length > MAX_SESSION_KEY_CHARS) return undefined;
  return SAFE_TIMESTAMP_RE.test(value) ? value : undefined;
}

export function summarizeCronRun(run: unknown): Record<string, unknown> {
  if (!run || typeof run !== "object" || Array.isArray(run)) return {};
  const src = run as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const timestamp = safeTimestamp(src.timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;
  const sessionKey = safeSessionKey(src.sessionKey);
  if (sessionKey !== undefined) out.sessionKey = sessionKey;
  const sessionId = safeSessionId(src.sessionId);
  if (sessionId !== undefined) out.sessionId = sessionId;
  const status = safeStatus(src.status);
  if (status !== undefined) out.status = status;
  const durationMs = safeNumber(src.durationMs);
  if (durationMs !== undefined) out.durationMs = durationMs;

  return out;
}
