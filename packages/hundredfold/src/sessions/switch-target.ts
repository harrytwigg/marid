import { claudeProfileFromDir } from "../shared/claude-profile.js";
import { declaredAccountByKey, declaredClaudeAccounts } from "../shared/claude-accounts-config.js";
import { claudeAccountKey } from "../shared/engine-account.js";
import { engineHealthForTarget, exhaustedEngineReturnsAt, isEngineExhausted, readEngineHealth } from "../shared/engine-health.js";
import { healthKeys } from "../shared/fallback-chain-health.js";
import { engineReadKeys } from "../shared/engine-health-keys.js";
import { getModelRegistry } from "../shared/models.js";
import { rateLimitEngineLabel } from "../shared/rateLimit.js";
import { isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import type { Employee, HundredfoldConfig, Session } from "../shared/types.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { engineInstalledWhereRun } from "./availability-registry.js";
import { standingOverride } from "./engine-override-revert.js";
import { namesClaudeProfile } from "./primary-profile.js";
import { scopedSwitchRefusal } from "./scoped-engine.js";
import { ownClaudeAccountOf, withoutAccountOverride } from "./session-account.js";
import { validateNewSessionSelection } from "./session-patch.js";
import { getEngineSessionRef } from "./registry.js";

/**
 * Who may switch a session to what: the one resolver behind the operator's selector and a
 * session's own switch. It turns a request (engine, Claude profile, model, effort) into the
 * target the switch writes, or a coded refusal. Rules (the design's R7):
 * the engine is one the registry knows and, for a session asking, installed where it runs; a
 * profile is a declared LOCAL account, never for a remote employee's session; a department-
 * scoped session stays on claude but may change profile; the model is one the engine offers;
 * and for a session asking, the target is neither its own nor out of its allowance.
 */

export type SwitchRefusalCode = "invalid-target" | "not-allowed" | "target-exhausted" | "same-target";

/** The status a refusal carries on a session's own switch; the operator's route answers every refusal 400. */
const REFUSAL_STATUS: Record<SwitchRefusalCode, 400 | 403 | 409> = {
  "invalid-target": 400,
  "same-target": 400,
  "not-allowed": 403,
  "target-exhausted": 409,
};

export interface SwitchTargetView {
  engine: string;
  /** The declared account's name; null is the session's own login (and, off Claude, no profile). */
  profile: string | null;
  /** The canonical profile directory the session runs on; null is own login. Off Claude it is the row's, kept for a return. */
  claudeConfigDir: string | null;
  model: string | null;
  effortLevel: string | null;
}

/** What a caller asks for. `profile` null or "" is the session's own login; every field is optional. */
export interface SwitchRequest {
  engine?: unknown;
  profile?: unknown;
  model?: unknown;
  effortLevel?: unknown;
}

export type SwitchResolution =
  | { ok: true; target: SwitchTargetView; own: SwitchTargetView; sameTarget: boolean }
  | { ok: false; code: SwitchRefusalCode; status: 400 | 403 | 409; error: string; until?: string; listEngine?: string };

export interface ResolveOptions {
  caller: "operator" | "session";
  now?: Date;
  /** The target was judged when it was asked for and is checked again as it is applied: its model may be one it inherited, not one it named. */
  reapply?: boolean;
}

function refusal(code: SwitchRefusalCode, error: string, until?: string): SwitchResolution {
  return { ok: false, code, status: REFUSAL_STATUS[code], error, ...(until ? { until } : {}) };
}

function employeeOf(config: HundredfoldConfig, session: Session): Employee | undefined {
  return session.employee ? orgRegistry(config).get(session.employee) : undefined;
}

function profileNameFor(config: HundredfoldConfig, dir: string | null): string | null {
  if (!dir) return null;
  return declaredAccountByKey(config, claudeAccountKey(claudeProfileFromDir(dir)))?.name ?? null;
}

/** The session's own target: the engine, profile and model it runs as when no stand-in holds (an engine override's original engine and model, not the stand-in's). */
export function ownSwitchTarget(config: HundredfoldConfig, session: Session): SwitchTargetView {
  const override = standingOverride(session);
  const engine = typeof override?.originalEngine === "string" ? override.originalEngine : session.engine;
  const model = override ? (typeof override.originalModel === "string" ? override.originalModel : null) : session.model;
  return {
    engine,
    profile: engine === "claude" ? profileNameFor(config, session.claudeConfigDir) : null,
    claudeConfigDir: session.claudeConfigDir,
    model,
    // The row's own pin: a stand-in's effort is never written to it, so it reads the same with or without one.
    effortLevel: session.effortLevel,
  };
}

function profileLabel(view: SwitchTargetView): string | null {
  if (view.engine !== "claude") return null;
  return view.claudeConfigDir ? (view.profile ?? "another profile") : "own login";
}

function modelLabel(config: HundredfoldConfig | undefined, view: SwitchTargetView): string | null {
  const entry = config ? getModelRegistry(config)[view.engine] : undefined;
  const id = view.model ?? entry?.defaultModel ?? null;
  return id ? (entry?.models.find((m) => m.id === id)?.label ?? id) : null;
}

/** A target as the operator reads it: `Claude · work · Sonnet`, `Claude · own login · Opus`, `Codex · gpt-5.5`. */
export function describeSwitchTarget(config: HundredfoldConfig | undefined, view: SwitchTargetView): string {
  return [rateLimitEngineLabel(view.engine), profileLabel(view), modelLabel(config, view)].filter(Boolean).join(" · ");
}

/** The account the session would run as on `claude` with this directory: the same-target comparison's key. */
export function claudeAccountFor(config: HundredfoldConfig, session: Session, dir: string | null): string {
  return ownClaudeAccountOf({ ...session, claudeConfigDir: dir }, employeeOf(config, session));
}

function effectiveModel(config: HundredfoldConfig, view: SwitchTargetView): string | null {
  return view.model ?? getModelRegistry(config)[view.engine]?.defaultModel ?? null;
}

/** Whether `target` is where the session already runs: same engine, same account (profiles compare by account key) and same model, null read as the engine's default. */
function isOwnTarget(config: HundredfoldConfig, session: Session, own: SwitchTargetView, target: SwitchTargetView): boolean {
  if (target.engine !== own.engine || effectiveModel(config, target) !== effectiveModel(config, own)) return false;
  return target.engine !== "claude" || claudeAccountFor(config, session, target.claudeConfigDir) === claudeAccountFor(config, session, own.claudeConfigDir);
}

function engineRefusal(config: HundredfoldConfig, session: Session, engine: string, opts: ResolveOptions): SwitchResolution | undefined {
  if (namesClaudeProfile(engine)) return refusal("invalid-target", `engine "${engine}" names a Claude profile; name the engine and give the profile separately`);
  if (!getModelRegistry(config)[engine]) return refusal("invalid-target", `unknown engine "${engine}"`);
  const scoped = scopedSwitchRefusal(session, engine);
  if (scoped) return refusal("not-allowed", scoped);
  // The selector lists installed engines only; a session asking names one blind, so it is checked where it would run.
  const employee = employeeOf(config, session);
  const destination = isRemoteTarget(employee) ? sshDestination(employee) : undefined;
  if (opts.caller === "session" && !engineInstalledWhereRun(config, engine, destination)) {
    return refusal("invalid-target", `engine "${engine}" is not installed where this session runs`);
  }
  return undefined;
}

/** The directory a profile request names (null: own login), or why it names none. Undefined `profile` keeps the row's. */
function resolveProfile(
  config: HundredfoldConfig,
  session: Session,
  engine: string,
  profile: unknown,
): { ok: true; dir: string | null } | Extract<SwitchResolution, { ok: false }> {
  if (profile === undefined) return { ok: true, dir: session.claudeConfigDir };
  if (engine !== "claude") return refusal("invalid-target", "profile applies only to the claude engine") as Extract<SwitchResolution, { ok: false }>;
  if (profile === null || profile === "") return { ok: true, dir: null };
  if (typeof profile !== "string") return refusal("invalid-target", "profile must be a string or null") as Extract<SwitchResolution, { ok: false }>;
  const name = profile.trim();
  const employee = employeeOf(config, session);
  if (isRemoteTarget(employee)) {
    return refusal("not-allowed", `employee "${employee.name}" runs on a remote host and uses that host's Claude login; it cannot switch to the local profile "${name}"`) as Extract<SwitchResolution, { ok: false }>;
  }
  const declared = declaredClaudeAccounts(config);
  const account = declared.find((candidate) => candidate.name === name);
  if (!account) {
    const known = declared.map((candidate) => candidate.name);
    return refusal("invalid-target", `unknown Claude profile "${name}" — ${known.length > 0
      ? `declared profiles: ${known.join(", ")}`
      : "no Claude profiles are declared under engines.claude.accounts"}`) as Extract<SwitchResolution, { ok: false }>;
  }
  return { ok: true, dir: account.profile.dir };
}

/** Why a session may not move to a target whose allowance is spent: the refusal with the window's end, or undefined. */
function exhaustedRefusal(config: HundredfoldConfig, session: Session, target: SwitchTargetView, now: Date): SwitchResolution | undefined {
  const employee = employeeOf(config, session);
  const health = engineHealthForTarget(readEngineHealth(now), employee);
  const account = target.engine === "claude" ? claudeAccountFor(config, session, target.claudeConfigDir) : target.engine;
  // A switch naming no model runs opencode's configured one, so its provider is the one read.
  const model = target.model ?? (target.engine === "opencode" ? config.engines.opencode?.model : undefined);
  const key = healthKeys({ engine: target.engine, model: model ?? undefined, account }).find((candidate) => isEngineExhausted(health, candidate, now));
  if (!key) return undefined;
  const until = exhaustedEngineReturnsAt(health, key, now).toISOString();
  return refusal("target-exhausted", `${describeSwitchTarget(config, target)} is out of allowance; it resets at ${until}`, until);
}

/** The model and effort a request keeps when it names none: the session's own when the engine stays, else the target slot's last. */
function inheritedSelection(session: Session, own: SwitchTargetView, engine: string, dir: string | null): { model?: string; effortLevel?: string } {
  if (engine === own.engine) return { model: own.model ?? undefined, effortLevel: own.effortLevel ?? undefined };
  const saved = getEngineSessionRef({ ...withoutAccountOverride(session), claudeConfigDir: dir }, engine);
  return { model: saved.model, effortLevel: saved.effortLevel };
}

function requestedEngine(own: SwitchTargetView, request: SwitchRequest): { ok: true; engine: string } | { ok: false; error: string } {
  if (request.engine === undefined) return { ok: true, engine: own.engine };
  if (typeof request.engine !== "string" || !request.engine.trim()) return { ok: false, error: "engine must be a non-empty string" };
  return { ok: true, engine: request.engine.trim() };
}

/** The refusals only a session asking for itself meets: its own target, and a target whose allowance is spent. */
function selfRefusal(config: HundredfoldConfig, session: Session, own: SwitchTargetView, target: SwitchTargetView, now: Date): SwitchResolution | undefined {
  if (isOwnTarget(config, session, own, target)) {
    return refusal("same-target", `this session already runs on ${describeSwitchTarget(config, own)} — call compact_session without a target to compact in place`);
  }
  return exhaustedRefusal(config, session, target, now);
}

/** Whether the target is another Claude account than the row's own: its slot then needs a pinned model to be recorded under. */
function movesAccount(config: HundredfoldConfig, session: Session, chosen: { engine: string; dir: string | null }): boolean {
  return chosen.engine === "claude" && claudeAccountFor(config, session, chosen.dir) !== claudeAccountFor(config, session, session.claudeConfigDir);
}

/** The engine's default model for a move to another Claude account, whose slot needs one recorded; otherwise none (the target's own). */
function pinnedModel(config: HundredfoldConfig, session: Session, chosen: { engine: string; dir: string | null }): string | null {
  return movesAccount(config, session, chosen) ? getModelRegistry(config)[chosen.engine]?.defaultModel ?? null : null;
}

/**
 * Why a named model cannot be switched to, for engines whose catalogue the validator cannot check (free ids: a typo or `?` passes it).
 * `?` is a list request, never a model. A session asking must name one the engine lists when it lists any.
 */
function modelRefusal(config: HundredfoldConfig, engine: string, model: unknown, opts: ResolveOptions): Extract<SwitchResolution, { ok: false }> | undefined {
  if (typeof model !== "string") return undefined;
  const id = model.trim();
  // A model refusal lists only the engine it is about, so its whole catalogue fits.
  const refused = (error: string) => ({ ...refusal("invalid-target", error), listEngine: engine }) as Extract<SwitchResolution, { ok: false }>;
  if (id === "?") return refused(`"?" is not a model — it asks for the list; these are the models "${engine}" offers`);
  if (opts.caller !== "session" || opts.reapply) return undefined;
  const listed = getModelRegistry(config)[engine]?.models ?? [];
  return listed.length > 0 && !listed.some((entry) => entry.id === id) ? refused(`unknown model "${id}" for engine "${engine}"`) : undefined;
}

/** The target for an engine and profile directory already cleared, with the model and effort checked against the engine. */
function buildTarget(
  config: HundredfoldConfig,
  session: Session,
  own: SwitchTargetView,
  chosen: { engine: string; dir: string | null },
  request: SwitchRequest,
): { ok: true; target: SwitchTargetView } | Extract<SwitchResolution, { ok: false }> {
  const kept = inheritedSelection(session, own, chosen.engine, chosen.dir);
  // The inherited effort goes in as a default, which the validator drops when the target model has no such level; a requested one is still refused.
  const selection = validateNewSessionSelection(
    config,
    { engine: chosen.engine, model: request.model ?? kept.model, effortLevel: request.effortLevel ?? undefined },
    { effortLevel: kept.effortLevel },
  );
  if (!selection.ok) return refusal("invalid-target", selection.error || "invalid engine/model/effort") as Extract<SwitchResolution, { ok: false }>;
  return {
    ok: true,
    target: {
      engine: chosen.engine,
      profile: chosen.engine === "claude" ? profileNameFor(config, chosen.dir) : null,
      claudeConfigDir: chosen.dir,
      model: selection.model ?? pinnedModel(config, session, chosen),
      effortLevel: selection.effortLevel ?? null,
    },
  };
}

/** The target `request` asks for on `session`, or the rule that refuses it. */
export function resolveSwitchTarget(config: HundredfoldConfig, session: Session, request: SwitchRequest, opts: ResolveOptions): SwitchResolution {
  const own = ownSwitchTarget(config, session);
  const named = requestedEngine(own, request);
  if (!named.ok) return refusal("invalid-target", named.error);
  const engineProblem = engineRefusal(config, session, named.engine, opts);
  if (engineProblem) return engineProblem;
  const profile = resolveProfile(config, session, named.engine, request.profile);
  if (!profile.ok) return profile;
  const modelProblem = modelRefusal(config, named.engine, request.model, opts);
  if (modelProblem) return modelProblem;
  const built = buildTarget(config, session, own, { engine: named.engine, dir: profile.dir }, request);
  if (!built.ok) return built;

  const refused = opts.caller === "session" ? selfRefusal(config, session, own, built.target, opts.now ?? new Date()) : undefined;
  return refused ?? { ok: true, target: built.target, own, sameTarget: isOwnTarget(config, session, own, built.target) };
}

/** What a target reads as to its allowance: `ok`, or `exhausted` with the end of the window. */
export interface SwitchTargetHealth {
  state: "ok" | "exhausted";
  until?: string;
}

export interface SwitchTargetProfile {
  /** The declared account's name; "" is the session's own login. */
  name: string;
  label: string;
  health: SwitchTargetHealth;
}

export interface SwitchTargetEngine {
  name: string;
  defaultModel: string;
  health: SwitchTargetHealth;
  models: Array<{ id: string; label: string; contextWindow?: number }>;
  /** Claude only, and not for a remote employee's session. */
  profiles?: SwitchTargetProfile[];
}

/** Every target a session may name, with what it reads as now: the structured list behind a refusal. */
export interface SwitchTargetList {
  current: { engine: string; profile: string | null; model: string | null };
  engines: SwitchTargetEngine[];
}

function healthOf(reading: ReturnType<typeof readEngineHealth>, keys: string[], now: Date): SwitchTargetHealth {
  const key = keys.find((candidate) => isEngineExhausted(reading, candidate, now));
  return key ? { state: "exhausted", until: exhaustedEngineReturnsAt(reading, key, now).toISOString() } : { state: "ok" };
}

/** The Claude profiles a session may name, own login first; none for a remote employee's session, which runs on its host's login. */
function listProfiles(config: HundredfoldConfig, session: Session, reading: ReturnType<typeof readEngineHealth>, now: Date): SwitchTargetProfile[] {
  const own = { name: "", label: "own login", dir: null as string | null };
  const declared = declaredClaudeAccounts(config).map((account) => ({ name: account.name, label: account.name, dir: account.profile.dir as string | null }));
  return [own, ...declared].map(({ name, label, dir }) => ({
    name,
    label,
    health: healthOf(reading, healthKeys({ engine: "claude", account: claudeAccountFor(config, session, dir) }), now),
  }));
}

/** An engine is out when its own keys say so; Claude is out only when every profile is. */
function engineHealth(config: HundredfoldConfig, name: string, profiles: SwitchTargetProfile[] | undefined, reading: ReturnType<typeof readEngineHealth>, now: Date): SwitchTargetHealth {
  if (!profiles) return healthOf(reading, engineReadKeys(name, config), now);
  const spent = profiles.filter((profile) => profile.health.state === "exhausted");
  if (spent.length < profiles.length) return { state: "ok" };
  const soonest = spent.map((profile) => profile.health.until ?? "").sort()[0];
  return { state: "exhausted", ...(soonest ? { until: soonest } : {}) };
}

/**
 * The targets {@link resolveSwitchTarget} would accept for this session, with their health
 * (an exhausted one, or the session's own, is listed but refused for a session asking).
 * Engines are the ones installed where the session runs; a department-scoped session
 * lists `claude` only; Claude's profiles are omitted for a remote employee's session.
 */
export function listSwitchTargets(config: HundredfoldConfig, session: Session, now: Date = new Date()): SwitchTargetList {
  const own = ownSwitchTarget(config, session);
  const employee = employeeOf(config, session);
  const remote = isRemoteTarget(employee);
  const destination = remote ? sshDestination(employee) : undefined;
  const reading = engineHealthForTarget(readEngineHealth(now), employee);
  const registry = getModelRegistry(config);
  const engines = Object.keys(registry)
    .filter((name) => !scopedSwitchRefusal(session, name) && engineInstalledWhereRun(config, name, destination))
    .map((name): SwitchTargetEngine => {
      const profiles = name === "claude" && !remote ? listProfiles(config, session, reading, now) : undefined;
      return {
        name,
        defaultModel: registry[name].defaultModel,
        health: engineHealth(config, name, profiles, reading, now),
        models: registry[name].models.map((model) => ({ id: model.id, label: model.label ?? model.id, ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}) })),
        ...(profiles ? { profiles } : {}),
      };
    });
  return { current: { engine: own.engine, profile: own.profile, model: own.model ?? registry[own.engine]?.defaultModel ?? null }, engines };
}

/** Whether the target leaves the session in the conversation slot it is in: the same engine, and for Claude the same account. */
export function staysInSlot(config: HundredfoldConfig, session: Session, target: SwitchTargetView): boolean {
  if (target.engine !== session.engine) return false;
  return target.engine !== "claude" || claudeAccountFor(config, session, target.claudeConfigDir) === claudeAccountFor(config, session, session.claudeConfigDir);
}
