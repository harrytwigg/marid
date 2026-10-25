import {
  fallbackLinkKey,
  fallbackLinkOf,
  type FallbackChainEntry,
  type FallbackChainSubject,
  type FallbackChainsResponse,
  type FallbackLink,
  type FallbackProfileOption,
} from "@jinn/fallback-chain-wire"
import type { Employee } from "@/lib/api"
import { engineDisplayName } from "@/lib/engine-names"
import type { EnginesResponse } from "@/lib/api"
import { linkOfResolved } from "@/routes/settings/engines/chain-links"
import { rowProblemsAgainst } from "@/routes/settings/engines/chain-problems"

/* What the employee screens need to know about a chain: whether it is the
 * employee's own, where an inherited one comes from, and what would run. */

/** The links an employee writes, or null when it writes none and inherits. */
export function employeeChainOf(employee: Employee): FallbackLink[] | null {
  // Links, or entries as written: either reads the same.
  const entries: readonly FallbackChainEntry[] | null | undefined = employee.fallback
  if (!Array.isArray(entries)) return null
  return entries.flatMap((entry) => fallbackLinkOf(entry) ?? [])
}

/** Same chain, whatever the spelling or the order a link's fields were written in: what decides whether the PATCH has anything to send. */
export function sameChain(a: FallbackLink[] | null, b: FallbackLink[] | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((link, i) => fallbackLinkKey(link) === fallbackLinkKey(b[i]))
}

type EmployeeHost = Pick<Employee, "remoteHost" | "remoteUser" | "remoteClaudeConfigDir" | "claudeProfile">

/** The ssh destination a remote employee runs on, as the gateway matches an account to it: `user@host`, or the bare host with no user. */
export function employeeDestination(employee: Pick<Employee, "remoteHost" | "remoteUser">): string | undefined {
  const host = employee.remoteHost?.trim()
  if (!host) return undefined
  const user = employee.remoteUser?.trim()
  return user ? `${user}@${host}` : host
}

/** The declared accounts this employee's chain may name: a remote employee's are those declared on its own `user@host`, a local one's the local ones. */
export function profilesForEmployee(employee: EmployeeHost, chains: FallbackChainsResponse | undefined): FallbackProfileOption[] {
  const destination = employeeDestination(employee)
  return (chains?.profiles ?? []).filter((p) => (destination === undefined ? p.remote === undefined : p.remote?.destination === destination))
}

/** How the picker names an account: a remote one with the host it is on. */
export function profileLabels(profiles: readonly FallbackProfileOption[]): Record<string, string> {
  return Object.fromEntries(profiles.filter((p) => p.remote).map((p) => [p.name, `${p.name} (${p.remote!.destination})`]))
}

const trimmedDir = (dir: string): string => (dir.length > 1 ? dir.trim().replace(/\/+$/, "") : dir)

/**
 * The declared account an employee's Claude profile is, when it is one: a local profile by its
 * directory among the local accounts; a remote employee's by its `remoteClaudeConfigDir` among the
 * accounts on its own destination (an employee that names no directory has none to match).
 */
export function declaredAccountOf(employee: EmployeeHost, chains: FallbackChainsResponse | undefined): string | undefined {
  if (employeeDestination(employee) !== undefined) {
    // The instance-wide `remote.claudeConfigDir` is not visible here: an employee relying on it has no directory to match.
    const dir = employee.remoteClaudeConfigDir
    return dir ? profilesForEmployee(employee, chains).find((p) => trimmedDir(p.configDir) === trimmedDir(dir))?.name : undefined
  }
  if (!employee.claudeProfile) return undefined
  return profilesForEmployee(employee, chains).find((p) => p.configDir === employee.claudeProfile!.path)?.name
}

export interface InheritedChain {
  /** "Claude · work" or "Codex": what the default is called. */
  label: string
  links: FallbackLink[]
  /** Worked out here, not read from the gateway: an unsaved change, shown as what would run once saved. */
  preview: boolean
  /** Where it comes from; `none` is a named Claude profile that is not a declared account. */
  source?: "account" | "engine" | "none"
}

/** What an inherited chain is called, from where the gateway says it comes from. */
export function inheritedLabel(source: InheritedChain["source"], sourceId: string | undefined, engine: string): string {
  if (source === "account") return `${engineDisplayName("claude")} · ${sourceId ?? ""}`
  if (source === "none") return `${engineDisplayName("claude")} · a profile with no declared account`
  return engineDisplayName(sourceId ?? engine)
}

function subjectOf(chains: FallbackChainsResponse | undefined, kind: FallbackChainSubject["kind"], id: string) {
  return chains?.subjects.find((s) => s.kind === kind && s.id === id)
}

/**
 * The chain an employee with none of its own follows, in the gateway's order: a Claude employee on a
 * declared account follows that account's chain, which is empty when the account writes none; on a
 * named profile that is not declared it follows none; the engine's chain is for the default profile
 * and for every other engine.
 */
export function inheritedChain(
  engine: string,
  claudeProfile: Employee["claudeProfile"],
  account: string | undefined,
  chains: FallbackChainsResponse | undefined,
): InheritedChain {
  if (engine === "claude" && account) {
    return { label: inheritedLabel("account", account, engine), links: subjectOf(chains, "account", account)?.effective.map(linkOfResolved) ?? [], preview: false, source: "account" }
  }
  if (engine === "claude" && claudeProfile) return { label: inheritedLabel("none", undefined, engine), links: [], preview: false, source: "none" }
  return { label: inheritedLabel("engine", engine, engine), links: subjectOf(chains, "engine", engine)?.effective.map(linkOfResolved) ?? [], preview: false, source: "engine" }
}

export function employeeSubject(chains: FallbackChainsResponse | undefined, name: string): FallbackChainSubject | undefined {
  return subjectOf(chains, "employee", name)
}

/**
 * What an employee that writes no chain follows, as the gateway says it: the employee subject's own
 * `effective`. The gateway is the source whenever it has a subject for what is on screen. It has none
 * for an unsaved engine change, and its subject describes the stored custom chain, not the default,
 * when the operator has just chosen "use the default" over one; only in those two cases is the chain
 * worked out here, and it is marked a preview.
 */
function serverInherited(subject: FallbackChainSubject | undefined, derived: InheritedChain, unsaved: boolean, engine: string): InheritedChain {
  // A subject that writes a chain is the employee's own, whether or not it says so in `source`.
  const source = subject?.source ?? (subject && subject.configured !== null ? "employee" : undefined)
  // Worked out here for an unsaved change: an engine the gateway has not seen, or "use the default" over a stored custom chain.
  if (unsaved || source === "employee") return { ...derived, preview: true }
  // No answer from the gateway yet (or none at all): nothing unsaved to preview.
  if (subject === undefined || source === undefined) return derived
  return { label: inheritedLabel(source, subject.sourceId, engine), links: subject.effective.map(linkOfResolved), preview: false, source }
}

/** The chain the editor shows and edits. */
export interface OwnChain {
  links: FallbackLink[]
  /** Per link: expanded from another entry's own chain. */
  expanded: boolean[]
  /** The employee's chain is written in engine names, so `links` is its expansion until it is edited. */
  legacy: boolean
}

/**
 * The employee's own chain as the editor shows it. One written in engine names is
 * shown as the gateway expands it, as Settings shows an engine's, until the first
 * edit: that edit then writes what runs, as explicit links, rather than the names alone.
 */
function ownChainOf(employee: Employee, value: FallbackLink[], subject: FallbackChainSubject | undefined): OwnChain {
  const written = employeeChainOf(employee)
  if (subject?.legacy && sameChain(value, written)) {
    return { links: subject.effective.map(linkOfResolved), expanded: subject.effective.map((l) => l.origin === "legacy"), legacy: true }
  }
  return { links: value, expanded: value.map(() => false), legacy: false }
}

/**
 * The employee's own target as the save would leave it, in every spelling the gateway refuses a link
 * to: with its model, and without (a link with no model runs the own model). The gateway checks a
 * PATCH against its new engine and model, so the editor's, or the saved ones when it has none.
 */
function ownTargetSpellings(employee: Employee, engine: string, account: string | undefined, model: string | undefined) {
  const target = model ?? (engine === employee.engine ? employee.model : undefined)
  const bare: FallbackLink = { engine, ...(account ? { profile: account } : {}) }
  const self: FallbackLink = target ? { ...bare, model: target } : bare
  const selves = target ? [self, bare] : [self]
  // A remote employee on a declared account also reaches its own login by naming no profile at all.
  if (account && employeeDestination(employee) !== undefined) selves.push({ engine }, ...(target ? [{ engine, model: target }] : []))
  return { self, selves }
}

/** What the field shows for an employee on `engine`, with `value` as its own chain (null inherits). */
export function fallbackFieldState(
  employee: Employee,
  engine: string,
  value: FallbackLink[] | null,
  chains: FallbackChainsResponse | undefined,
  /** The model the editor now has; the saved one when it does not say. */
  model?: string,
) {
  const account = engine === "claude" ? declaredAccountOf(employee, chains) : undefined
  const subject = employeeSubject(chains, employee.name)
  // A remote account has no chain of its own: a remote employee inherits its engine's, whatever account it is on.
  const inheritedAccount = employeeDestination(employee) === undefined ? account : undefined
  const inherited = serverInherited(subject, inheritedChain(engine, employee.claudeProfile, inheritedAccount, chains), engine !== employee.engine, engine)
  const { self, selves } = ownTargetSpellings(employee, engine, account, model)
  const own = value === null ? null : ownChainOf(employee, value, subject)
  const changed = !sameChain(value, employeeChainOf(employee))
  const options = profilesForEmployee(employee, chains)
  return { inherited, self, selves, shown: own?.links ?? inherited.links, own, subject, changed, profiles: options.map((p) => p.name), profileLabels: profileLabels(options) }
}

/** How many problems the validator finds in an employee's own chain: a chain with any is not saved. */
export function chainProblemCount(
  links: FallbackLink[],
  selves: readonly FallbackLink[],
  registry: EnginesResponse,
  /** The account names this employee's chain may name (`profilesForEmployee`). */
  profiles: readonly string[],
): number {
  const ctx = { engines: Object.values(registry.engines), profiles: [...profiles] }
  const found = rowProblemsAgainst("fallback", links, ctx, selves)
  return found.byRow.flat().length + found.general.length
}

export { subjectProblems } from "@/hooks/use-fallback-chains"

/**
 * Whether the editor must hold the save: the employee's own chain, once the registry is known,
 * has a problem and the operator has changed it. A chain stored with a repeated target is the
 * gateway's to report on load; it does not stop an edit to something else from saving, and only
 * an edit to the chain itself is refused until the chain is fixed.
 */
export function chainBlocked(
  registry: EnginesResponse | undefined,
  own: OwnChain | null,
  selves: readonly FallbackLink[],
  profiles: readonly string[],
  changed: boolean,
): boolean {
  return changed && registry !== undefined && own !== null && chainProblemCount(own.links, selves, registry, profiles) > 0
}
