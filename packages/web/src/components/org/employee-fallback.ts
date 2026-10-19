import {
  fallbackLinkKey,
  fallbackLinkOf,
  type FallbackChainEntry,
  type FallbackChainSubject,
  type FallbackChainsResponse,
  type FallbackLink,
} from "@jinn/fallback-chain-wire"
import type { Employee } from "@/lib/api"
import { engineDisplayName } from "@/lib/engine-names"
import type { EnginesResponse } from "@/lib/api"
import { linkOfResolved } from "@/routes/settings/engines/chain-links"
import { rowProblems, validatorContext } from "@/routes/settings/engines/chain-problems"

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

/** The declared account an employee's Claude profile is, by directory, when it is one. */
export function declaredAccountOf(
  claudeProfile: Employee["claudeProfile"],
  chains: FallbackChainsResponse | undefined,
): string | undefined {
  if (!claudeProfile) return undefined
  return chains?.profiles.find((p) => p.configDir === claudeProfile.path)?.name
}

export interface InheritedChain {
  /** "Claude · work" or "Codex": what the default is called. */
  label: string
  links: FallbackLink[]
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
    return { label: `${engineDisplayName(engine)} · ${account}`, links: subjectOf(chains, "account", account)?.effective.map(linkOfResolved) ?? [] }
  }
  if (engine === "claude" && claudeProfile) return { label: `${engineDisplayName(engine)} · a profile with no declared account`, links: [] }
  return { label: engineDisplayName(engine), links: subjectOf(chains, "engine", engine)?.effective.map(linkOfResolved) ?? [] }
}

export function employeeSubject(chains: FallbackChainsResponse | undefined, name: string): FallbackChainSubject | undefined {
  return subjectOf(chains, "employee", name)
}

/**
 * What an employee that writes no chain follows, as the gateway says: the employee subject's own
 * `effective`, when the stored chain is none. Only an unsaved draft (the operator has just chosen
 * "use the default" over a stored custom chain, so the subject describes that chain, not the
 * default) falls back to working it out from the account or engine subject.
 */
function serverInherited(subject: FallbackChainSubject | undefined, derived: InheritedChain): InheritedChain {
  if (subject === undefined || subject.configured !== null) return derived
  return { label: derived.label, links: subject.effective.map(linkOfResolved) }
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

/** What the field shows for an employee on `engine`, with `value` as its own chain (null inherits). */
export function fallbackFieldState(
  employee: Employee,
  engine: string,
  value: FallbackLink[] | null,
  chains: FallbackChainsResponse | undefined,
) {
  const account = engine === "claude" ? declaredAccountOf(employee.claudeProfile, chains) : undefined
  const subject = employeeSubject(chains, employee.name)
  const inherited = serverInherited(subject, inheritedChain(engine, employee.claudeProfile, account, chains))
  const self: FallbackLink = { engine, ...(account ? { profile: account } : {}) }
  const own = value === null ? null : ownChainOf(employee, value, subject)
  const changed = !sameChain(value, employeeChainOf(employee))
  return { inherited, self, shown: own?.links ?? inherited.links, own, subject, changed }
}

/** How many problems the validator finds in an employee's own chain: a chain with any is not saved. */
export function chainProblemCount(
  links: FallbackLink[],
  self: FallbackLink,
  registry: EnginesResponse,
  chains: FallbackChainsResponse | undefined,
): number {
  const ctx = { engines: Object.values(registry.engines), profiles: chains?.profiles.map((p) => p.name) ?? [] }
  const found = rowProblems("fallback", links, validatorContext(ctx, self))
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
  self: FallbackLink,
  chains: FallbackChainsResponse | undefined,
  changed: boolean,
): boolean {
  return changed && registry !== undefined && own !== null && chainProblemCount(own.links, self, registry, chains) > 0
}
