/**
 * Fallback chains: the shapes and sentences shared by the gateway and the web.
 *
 * A chain is an ordered list of targets. Each link names an engine, and may name
 * a profile (a declared account under `engines.claude.accounts`) and a model. A
 * turn that cannot be served by its own target walks the chain in order, trying
 * each target at most once, until one serves it. See docs/fallback-chains.md.
 *
 * Like `fallback-map-wire.ts`, this module is a pure leaf with no imports:
 * `packages/web` aliases it as `@jinn/fallback-chain-wire` and bundles it, so the
 * config loader and the Settings editor refuse a broken chain in the same words.
 */

/** One target in a chain, as config spells it in its object form. */
export interface FallbackLink {
  engine: string;
  /** A declared account name under `engines.claude.accounts`. Absent: the
   *  default Claude profile. Only Claude links take a profile. */
  profile?: string;
  /** A model id the engine serves (`provider/model` for opencode). Absent: the
   *  session's own model on the same engine, otherwise the `fallbackModelMap`
   *  translation, otherwise the engine's default. */
  model?: string;
}

/**
 * A chain entry as config may hold it. The string forms are the legacy ones and
 * keep their legacy meaning: an engine name or `claude:<name>` stands for that
 * target followed by its own chain, walked as before; an object is exactly one
 * target.
 */
export type FallbackChainEntry = string | FallbackLink;

/** Why a link was left without trying it, or why the walk moved past it. */
export type FallbackSkipReason =
  | "tried" // already tried in this run (the loop guard)
  | "not-installed"
  | "scoped" // a department-scoped session runs on Claude accounts only
  | "remote" // the engine or profile cannot run on the session's host
  | "exhausted" // health says it is at its limit; tried only if nothing else is left
  | "model-not-served"
  | "profile-unknown";

/** Why a run moved from one target to the next. */
export type FallbackHopReason =
  | "rate-limit"
  | "quota"
  | "retry-exhausted" // the engine gave up on its own provider retries
  | "invalid-model" // only on a fallback link, never the session's own target
  | "auth"; // a fallback link's profile is signed out; only on a fallback link

/** Limit state of one target, from engine health and the latest limits reading. */
export interface FallbackLinkHealth {
  state: "ok" | "degraded" | "exhausted" | "unknown";
  /** ISO time the limit is expected to clear. */
  until?: string;
  /** Highest used percentage across the account's windows, when a reading has one. */
  usedPercent?: number;
  /** The window that is binding, e.g. "5h" or "weekly". */
  window?: string;
}

/** A link as the gateway resolved it for one subject or session. */
export interface ResolvedFallbackLink extends FallbackLink {
  /** Stable identity of the target: see {@link fallbackLinkKey}. */
  key: string;
  /** The per-account store key the target runs as (`claude`, `claude:<profile key>`, `opencode`, ...). */
  account: string;
  /** Short operator-facing name, e.g. "claude · work · sonnet". */
  label: string;
  /** "config" for a written link; "legacy" for one expanded from a string entry's own chain. */
  origin: "config" | "legacy";
  /** The link as config spells it, before the gateway filled in the model it would run
   *  (`model` above is that resolved model). This is what an editor shows as the
   *  operator's choice and writes back; writing `engine`/`profile`/`model` instead would
   *  pin a model the operator never chose. Always set by the gateway. */
  written?: FallbackLink;
  /** Present when the link cannot be used at all for this subject or session. */
  skip?: FallbackSkipReason;
  /** The skip in the gateway's words, when it has more to say than the reason:
   *  for a session on a remote host, which host lacks the engine's CLI. */
  skipDetail?: string;
  health?: FallbackLinkHealth;
}

/** A link a hop passed over. */
export interface FallbackHopSkip {
  key: string;
  reason: FallbackSkipReason;
  detail?: string;
}

/** One move along a chain, recorded on the session and announced in its transcript. */
export interface FallbackHop {
  at: string;
  from: string; // link key
  to: string | null; // link key; null when the chain ran out and the session waits
  fromLabel: string;
  toLabel: string | null;
  reason: FallbackHopReason;
  /** The failing target's reset, when it stated one. */
  resetsAt?: string;
  /** Links passed over on the way to `to`, with why (`detail`: the link's `skipDetail`). */
  skipped?: FallbackHopSkip[];
}

/**
 * The `meta` of the transcript notice that announces a hop: a `notification`
 * message whose `meta.fallbackHop` is the hop. The web renders it as a card; a
 * notification without the key is an ordinary notice.
 */
export interface FallbackHopNoticeMeta {
  fallbackHop: FallbackHop;
}

/** Where a session's chain came from, highest precedence first. */
export type FallbackChainSource = "session" | "employee" | "account" | "engine" | "none";

/** A session's chain as the session API reports it (`fallback.chain`). */
export interface SessionFallbackChainView {
  source: FallbackChainSource;
  /** Index 0 is the session's own target; the rest is the chain in order. */
  links: ResolvedFallbackLink[];
  /** Index into `links` of the target the session is on now. */
  position: number;
  /** Key of the target that served the latest turn, if any turn ran. */
  servedBy: string | null;
  /** Key of the target the next limit would move to, if any. */
  next: string | null;
  /** Most recent first, at most 20. */
  hops: FallbackHop[];
}

/** A Claude profile a chain link may name. */
export interface FallbackProfileOption {
  name: string;
  account: string;
  configDir: string;
}

/** One editable chain: an engine default, a declared account's, or an employee's. */
export interface FallbackChainSubject {
  kind: "engine" | "account" | "employee";
  /** Engine name, account name, or employee name. */
  id: string;
  /** The target the chain falls back from (the employee's own target; for an engine
   *  or account, its default model). */
  primary: ResolvedFallbackLink | null;
  /** The chain as written, normalised to links. Null: the subject writes none (an
   *  employee then inherits; an engine or account has no fallback). */
  configured: FallbackLink[] | null;
  /** True when `configured` came from string entries, whose own chains expand. */
  legacy: boolean;
  /** What would run, in order, after legacy expansion and de-duplication. */
  effective: ResolvedFallbackLink[];
  /** An employee only: where `effective` comes from. `employee` is its own chain; an
   *  inherited one is its declared account's (`account`, named by `sourceId`) or its
   *  engine's (`engine`, named by `sourceId`); `none` is a named profile that is not
   *  declared, which has no fallback. The gateway decides this, so a client never
   *  reconstructs it. */
  source?: Exclude<FallbackChainSource, "session">;
  sourceId?: string;
  /** What is wrong with the chain the subject wrote. A repeated target is tolerated (the
   *  chain is kept and lists it once); an employee whose YAML chain failed validation at
   *  load inherits instead. Absent when nothing is wrong. */
  problems?: string[];
}

/** `GET /api/fallback-chains` (with `?employee=<name>` an employee subject is added). */
export interface FallbackChainsResponse {
  profiles: FallbackProfileOption[];
  subjects: FallbackChainSubject[];
}

const CONTROL_CHARACTER_RE = new RegExp("[\\u0000-\\u001f\\u007f]");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * One entry as a link, or null when it is neither form. `claude:<name>` becomes a
 * Claude link on that profile and any other string an engine-only link; whether
 * the names exist is {@link fallbackChainProblems}'s question, not this one's.
 */
export function fallbackLinkOf(entry: unknown): FallbackLink | null {
  if (typeof entry === "string") {
    const text = entry.trim();
    if (!text) return null;
    if (text.startsWith("claude:")) return { engine: "claude", profile: text.slice("claude:".length) };
    return { engine: text };
  }
  if (!isRecord(entry)) return null;
  const engine = optionalText(entry.engine);
  if (!engine) return null;
  const profile = optionalText(entry.profile);
  const model = optionalText(entry.model);
  return { engine, ...(profile ? { profile } : {}), ...(model ? { model } : {}) };
}

/** Identity of a target: two links with the same key are the same target. */
export function fallbackLinkKey(link: FallbackLink): string {
  return `${link.engine}|${link.profile ?? ""}|${link.model ?? ""}`;
}

/** Operator-facing name of a link, e.g. "claude · work · sonnet" or "opencode · openrouter/x". */
export function fallbackLinkLabel(link: FallbackLink): string {
  return [link.engine, link.profile, link.model].filter(Boolean).join(" · ");
}

/** What the validator needs to know about the instance. */
export interface FallbackChainContext {
  /** Every engine name this build knows. */
  engines: readonly string[];
  /** Declared account names under `engines.claude.accounts`. */
  profiles: ReadonlySet<string>;
  /** The target the chain falls back from, where it is known: a link equal to it
   *  is refused. For an engine default it is `{engine}`, for an account
   *  `{engine: "claude", profile}`. */
  self?: FallbackLink;
  /** Asked about each duplicate; returning true tolerates it (the first entry stays and
   *  no problem is reported). The loader tolerates what the legacy validator accepted. */
  onDuplicate?: (duplicate: FallbackChainDuplicate) => boolean;
}

/** A chain entry that repeats an earlier one, as {@link FallbackChainContext.onDuplicate} sees it. */
export interface FallbackChainDuplicate {
  where: string;
  chain: readonly unknown[];
  index: number;
  first: number;
  problem: string;
}

function profileProblems(where: string, link: FallbackLink, ctx: FallbackChainContext): string[] {
  if (link.profile === undefined) return [];
  if (link.engine !== "claude") return [`${where}: only a claude target takes a profile`];
  return ctx.profiles.has(link.profile) ? [] : [`${where}: profile "${link.profile}" names no account under engines.claude.accounts`];
}

function modelProblems(where: string, entry: unknown): string[] {
  if (!isRecord(entry) || entry.model === undefined) return [];
  const { model } = entry;
  return typeof model === "string" && model.trim() && !CONTROL_CHARACTER_RE.test(model) ? [] : [`${where}.model must be a model id`];
}

function entryProblems(where: string, entry: unknown, ctx: FallbackChainContext): string[] {
  const link = fallbackLinkOf(entry);
  if (!link) return [`${where} must be an engine name or a mapping with engine, profile and model`];
  const engine = ctx.engines.includes(link.engine) ? [] : [`${where}: "${link.engine}" is not a known engine (${ctx.engines.join(", ")})`];
  return [...engine, ...profileProblems(where, link, ctx), ...modelProblems(where, entry)];
}

/**
 * Problems with one chain (empty = valid). Refused: an entry of neither form, an
 * unknown engine, a profile on a non-Claude link or naming no declared account,
 * a model that is not an id, a link that is the chain's own target, and a link
 * listed twice. Distinct targets are all accepted, including the same engine on
 * another profile or model.
 */
export function fallbackChainProblems(where: string, chain: unknown, ctx: FallbackChainContext): string[] {
  if (chain === undefined) return [];
  if (!Array.isArray(chain)) return [`${where} must be a list of fallback targets`];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const selfKey = ctx.self ? fallbackLinkKey(ctx.self) : undefined;
  chain.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    const own = entryProblems(at, entry, ctx);
    problems.push(...own);
    const link = fallbackLinkOf(entry);
    if (!link || own.length > 0) return;
    const key = fallbackLinkKey(link);
    if (key === selfKey) {
      problems.push(`${at} (${fallbackLinkLabel(link)}) is the target this chain falls back from; give it another profile or model`);
      return;
    }
    const first = seen.get(key);
    if (first !== undefined) {
      const problem = `${at} duplicates ${where}[${first}] (${fallbackLinkLabel(link)}): a chain tries each target once, so list it once`;
      if (!ctx.onDuplicate?.({ where, chain, index, first, problem })) problems.push(problem);
    } else {
      seen.set(key, index);
    }
  });
  return problems;
}
