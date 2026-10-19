import {
  fallbackLinkOf,
  type FallbackChainEntry,
  type FallbackChainSubject,
  type FallbackChainsResponse,
  type FallbackLink,
} from "@jinn/fallback-chain-wire"
import type { Employee } from "@/lib/api"
import type { EmployeeFallbackFields } from "@/lib/fallback-chains-api"
import { engineDisplayName } from "@/lib/engine-names"
import { linkOfResolved } from "@/routes/settings/engines/chain-links"

/* What the employee screens need to know about a chain: whether it is the
 * employee's own, where an inherited one comes from, and what would run. */

/** The links an employee writes, or null when it writes none and inherits. */
export function employeeChainOf(employee: Employee & EmployeeFallbackFields): FallbackLink[] | null {
  const entries: FallbackChainEntry[] | null | undefined = employee.fallback
  if (!Array.isArray(entries)) return null
  return entries.flatMap((entry) => fallbackLinkOf(entry) ?? [])
}

/** Same chain, whatever the spelling: what decides whether the PATCH has anything to send. */
export function sameChain(a: FallbackLink[] | null, b: FallbackLink[] | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
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
 * The chain an employee with none of its own follows: its account's when it runs
 * on a declared account that writes one, else its engine's.
 */
export function inheritedChain(engine: string, account: string | undefined, chains: FallbackChainsResponse | undefined): InheritedChain {
  const accountSubject = engine === "claude" && account ? subjectOf(chains, "account", account) : undefined
  if (account && accountSubject?.configured?.length) {
    return { label: `${engineDisplayName(engine)} · ${account}`, links: accountSubject.effective.map(linkOfResolved) }
  }
  const links = subjectOf(chains, "engine", engine)?.effective.map(linkOfResolved) ?? []
  return { label: engineDisplayName(engine), links }
}

export function employeeSubject(chains: FallbackChainsResponse | undefined, name: string): FallbackChainSubject | undefined {
  return subjectOf(chains, "employee", name)
}

/** What the field shows for an employee on `engine`, with `value` as its own chain (null inherits). */
export function fallbackFieldState(
  employee: Employee,
  engine: string,
  value: FallbackLink[] | null,
  chains: FallbackChainsResponse | undefined,
) {
  const account = engine === "claude" ? declaredAccountOf(employee.claudeProfile, chains) : undefined
  const inherited = inheritedChain(engine, account, chains)
  const self: FallbackLink = { engine, ...(account ? { profile: account } : {}) }
  return { inherited, self, shown: value ?? inherited.links, subject: employeeSubject(chains, employee.name) }
}

export { subjectProblems } from "@/hooks/use-fallback-chains"
