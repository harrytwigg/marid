/**
 * The config document as it crosses the API: redacted on the way out, merged back
 * over the file on the way in.
 *
 * The two halves belong together because they are one round trip. `sanitizeConfigForApi`
 * replaces every secret with a sentinel so the UI never holds one, and `deepMerge`
 * recognises that same sentinel coming back and keeps what is already on disk —
 * split them apart and a PUT writes "***" into config.yaml as a literal token.
 */
const REDACTED_SECRET = "***";

export function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey") ||
    normalized.includes("password") ||
    normalized === "authorization"
  );
}

/**
 * Whether this key/value pair is a secret worth replacing with the sentinel.
 * An absent or empty value has nothing to hide, and `tokenThreshold` is a count
 * that only looks like a credential to a substring match on the key.
 */
function holdsSecret(key: string, value: unknown): boolean {
  if (!isSensitiveConfigKey(key)) return false;
  if (key === "tokenThreshold" && typeof value === "number") return false;
  return value !== undefined && value !== null && value !== "";
}

/**
 * Replace any secret-bearing fields with the "***" sentinel before sending
 * config to the UI.
 * deepMerge round-trips the sentinel back to the original value on PUT.
 */
export function sanitizeConfigForApi<T>(value: T, key = ""): T {
  if (holdsSecret(key, value)) return REDACTED_SECRET as T;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfigForApi(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeConfigForApi(childValue, childKey);
    }
    return out as T;
  }
  return value;
}

/**
 * config.yaml as GET /api/config serves it: secrets replaced with the sentinel, and
 * only the keys a PUT may carry. GET and PUT are one round trip — the Settings page
 * saves back the document it was handed — so serving a key the PUT refuses ("Unknown
 * config keys: ...") makes every save from that page fail, and one key config.yaml
 * holds that this build does not declare is enough to do it. Dropping it here costs
 * nothing: a PUT deep-merges into the file, so what the body omits stays on disk.
 */
export function configDocumentForApi(config: object, savableKeys: string[]): Record<string, unknown> {
  const savable = Object.entries(config).filter(([key]) => savableKeys.includes(key));
  return sanitizeConfigForApi(Object.fromEntries(savable));
}

/** A YAML mapping, as opposed to a scalar or a list. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A list replaces what is on disk, except that an item matching a stored one by
 * `id` is merged into it — that is what lets a connector instance keep the token
 * the UI only ever saw as a sentinel.
 */
function mergeArrayItems(source: unknown[], target: unknown): unknown[] {
  if (!Array.isArray(target)) return source;
  return source.map((item) => {
    if (!isMapping(item)) return item;
    const match = target.find((t) => t && typeof t === "object" && (t as Record<string, unknown>).id === item.id);
    return match ? deepMerge(match as Record<string, unknown>, item) : item;
  });
}

/**
 * Config keys whose mapping value is a complete table rather than a patch, so a
 * PUT replaces it instead of unioning with what is on disk.
 *
 * Without this, removing one entry from `fallbackModelMap` cannot be expressed:
 * the PUT carries the map the operator wants, the merge adds the dropped key
 * back off disk, and the row reappears on the next reload. Arrays already behave
 * this way, which is why editing the `fallback` chain never had the bug.
 * `engines.opencode.usageLimits.monthlyUsd` is the same kind of table.
 */
const REPLACED_NOT_MERGED_KEYS = new Set(["fallbackModelMap", "monthlyUsd"]);

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    // A sanitized secret keeps the stored value; an explicit null clears the field.
    if (isSensitiveConfigKey(key) && sv === REDACTED_SECRET) continue;
    if (sv === null) delete result[key];
    else if (REPLACED_NOT_MERGED_KEYS.has(key)) result[key] = sv;
    else if (Array.isArray(sv)) result[key] = mergeArrayItems(sv, tv);
    else if (isMapping(sv) && isMapping(tv)) result[key] = deepMerge(tv, sv);
    else result[key] = sv;
  }
  return result;
}
