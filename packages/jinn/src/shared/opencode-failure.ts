/**
 * What opencode's own error says about a failed provider call.
 *
 * opencode 2 reports a provider failure as `{type, message, status?}`, and both
 * transports (`opencode run`, the server) put it into a turn's error text in one
 * shape, `<type>: <message> (HTTP <status>)` (see `opencodeErrorText` and
 * `v2ErrorLine`). The type and status are therefore read from that text first;
 * the prose regexes of `engine-failure.ts` are for errors that carry no type.
 *
 * A spent allowance, a dead key and a model the account is not enabled for are
 * three different facts about three different targets, and the prose classifier
 * cannot tell the last two apart: both are `provider.auth`.
 */

/**
 * - `quota`: HTTP 402, the account has no usable allowance or balance.
 * - `usage-limit`: HTTP 429, a spent window; may state when it reopens.
 * - `auth`: HTTP 401, the key is expired or invalid. The whole provider is out.
 * - `model-access`: HTTP 403, this model is not enabled for the account, or the
 *   region has not opted in. Only that (provider, model) is out.
 */
export type OpencodeFailureKind = "quota" | "usage-limit" | "auth" | "model-access";

export interface OpencodeFailure {
  kind: OpencodeFailureKind;
  /** opencode's error type (`provider.quota`), when the text carries one. */
  type?: string;
  status?: number;
}

const TYPE_RE = /\b(provider\.[a-z][a-z-]*)\s*:/;
const STATUS_RE = /\(HTTP (\d{3})\)/g;

/** A 403 or typeless `provider.auth` message that is about the model or region, not the key. */
const MODEL_ACCESS_MESSAGE_RE = /model access|not enabled|not available in (?:your|this) region|region|opt[ -]?in|\bnot (?:served|available)\b/i;
/** A message that is about the key itself. */
const KEY_MESSAGE_RE = /\b(?:expired|invalid|revoked|unauthori[sz]ed|forbidden)\b|api key/i;

function statusOf(text: string): number | undefined {
  let status: number | undefined;
  for (const match of text.matchAll(STATUS_RE)) status = Number(match[1]);
  return status;
}

/** What a typed error with no status, or one status does not settle, says by its message. */
function kindByMessage(type: string, error: string): OpencodeFailureKind | undefined {
  if (type === "provider.quota") return /usage.*limit|exceeded.*limit/i.test(error) ? "usage-limit" : "quota";
  if (type !== "provider.auth") return undefined;
  if (MODEL_ACCESS_MESSAGE_RE.test(error)) return "model-access";
  return KEY_MESSAGE_RE.test(error) ? "auth" : undefined;
}

const KIND_BY_STATUS: Readonly<Record<number, OpencodeFailureKind>> = { 402: "quota", 429: "usage-limit", 401: "auth", 403: "model-access" };

function kindOf(type: string, status: number | undefined, error: string): OpencodeFailureKind | undefined {
  if (/\bRegionError\b/.test(error)) return "model-access";
  if (type === "provider.rate-limit") return "usage-limit";
  // A 403 that names the key (not a model or region) is a bad credential, as a 401 is.
  if (status === 403 && KEY_MESSAGE_RE.test(error) && !MODEL_ACCESS_MESSAGE_RE.test(error)) return "auth";
  return (status === undefined ? undefined : KIND_BY_STATUS[status]) ?? kindByMessage(type, error);
}

/**
 * The failure an opencode turn's error text reports, or undefined when it is not
 * one of the four above (including every text with no `provider.*` type: those
 * are the prose classifier's).
 */
export function classifyOpencodeFailure(error: string | null | undefined): OpencodeFailure | undefined {
  if (typeof error !== "string" || !error) return undefined;
  const type = TYPE_RE.exec(error)?.[1];
  if (!type) return /\bRegionError\b/.test(error) ? { kind: "model-access" } : undefined;
  const status = statusOf(error);
  const kind = kindOf(type, status, error);
  return kind === undefined ? undefined : { kind, type, ...(status === undefined ? {} : { status }) };
}

/** Whether the error is one this module classifies as a refusal that no retry on the same target fixes: a dead key or a model the account cannot use. */
export function isOpencodeRefusal(error: string | null | undefined): boolean {
  const kind = classifyOpencodeFailure(error)?.kind;
  return kind === "auth" || kind === "model-access";
}
