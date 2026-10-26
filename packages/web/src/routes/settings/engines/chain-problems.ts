import {
  fallbackChainProblems,
  type FallbackChainContext,
  type FallbackLink,
} from "@jinn/fallback-chain-wire"
import { accountEntriesFor, accountNames, allAccountNames, chainEntriesFor, type EnginesConfig } from "./chain-model"
import type { ChainContext } from "./chain-links"

/* Chain validation on the client. The sentences are the wire module's own, so a
 * chain the editor refuses is refused in the words the config loader would use. */

/** The validator's view of the instance. */
export function validatorContext(ctx: ChainContext, self: FallbackLink | undefined): FallbackChainContext {
  return { engines: ctx.engines.map((e) => e.name), profiles: new Set(ctx.profiles), self }
}

/**
 * The problems of each row, by row index. A sentence names its row as `where[i]`;
 * one that names no row belongs to the chain as a whole and is under row 0, or
 * returned in `general` when the chain has no rows.
 */
export function rowProblems(
  where: string,
  links: FallbackLink[],
  ctx: FallbackChainContext,
): { byRow: string[][]; general: string[] } {
  const byRow: string[][] = links.map(() => [])
  const general: string[] = []
  const prefix = `${where}[`
  for (const sentence of fallbackChainProblems(where, links, ctx)) {
    const at = sentence.startsWith(prefix) ? Number.parseInt(sentence.slice(prefix.length), 10) : Number.NaN
    if (Number.isInteger(at) && byRow[at]) byRow[at].push(sentence)
    else general.push(sentence)
  }
  return { byRow, general }
}

interface RegistryEngines {
  [name: string]: { name: string }
}

/** Every chain in the document and where it is written: an engine's, and each declared account's. */
function chainsOf(engines: EnginesConfig | undefined, names: string[]): { where: string; chain: unknown; self: FallbackLink }[] {
  const chains = names.map((name) => ({
    where: `engines.${name}.fallback`,
    chain: chainEntriesFor(engines, name),
    self: { engine: name },
  }))
  const accounts = accountNames(engines).map((account) => ({
    where: `engines.claude.accounts.${account}.fallback`,
    chain: accountEntriesFor(engines, account),
    self: { engine: "claude", profile: account },
  }))
  return [...chains, ...accounts]
}

/**
 * Why this config cannot be saved yet because of a chain, or null. Asked before
 * the PUT, as the model-map blocker is, so the document the loader would refuse
 * never goes out. Asks nothing until the registry has said which engines exist.
 * With `loaded` (the engines block as last read), only chains that differ from it are
 * asked: one already stored with a problem still shows it on its card, and does not
 * stop an edit to another chain from saving.
 */
export function chainSaveBlocker(
  engines: EnginesConfig | undefined,
  registry: RegistryEngines | undefined,
  loaded?: EnginesConfig,
): string | null {
  const names = Object.keys(registry ?? {})
  if (names.length === 0) return null
  const ctx = { engines: names, profiles: new Set(allAccountNames(engines)) }
  const before = new Map(chainsOf(loaded, names).map(({ where, chain }) => [where, JSON.stringify(chain)]))
  const problems = chainsOf(engines, names)
    // A chain this edit did not change is the gateway's to report, not a reason to refuse an unrelated save.
    .filter(({ where, chain }) => loaded === undefined || before.get(where) !== JSON.stringify(chain))
    .flatMap(({ where, chain, self }) => fallbackChainProblems(where, chain, { ...ctx, self }))
  return problems.length > 0 ? `Cannot save: ${problems.join("; ")}` : null
}

/**
 * The problems of each row against every spelling of the target the chain falls back from.
 * An employee's own target has two: with its model, and without one (a link with no model runs
 * the own model on the own engine), and the gateway refuses both. A sentence found twice is kept once.
 */
export function rowProblemsAgainst(
  where: string,
  links: FallbackLink[],
  ctx: ChainContext,
  selves: readonly FallbackLink[],
): { byRow: string[][]; general: string[] } {
  const runs = (selves.length > 0 ? selves : [undefined]).map((self) => rowProblems(where, links, validatorContext(ctx, self)))
  const unique = (lists: string[][]) => [...new Set(lists.flat())]
  return {
    byRow: links.map((_, i) => unique(runs.map((run) => run.byRow[i] ?? []))),
    general: unique(runs.map((run) => run.general)),
  }
}


/** Why a declared account may not be named on this chain: the sentence for `at` (`fallback[0]: profile "x"`) and the profile's name, or undefined when it may. */
export type HostProblem = (at: string, profile: string) => string | undefined

/**
 * Per row, the host-specific reason its Claude profile is refused (an account on the wrong side),
 * in the gateway's own sentence. A name that is declared nowhere gets none: the validator refuses it as naming no account.
 */
export function hostRowProblems(where: string, links: FallbackLink[], hostProblem: HostProblem | undefined): string[][] {
  return links.map((link, index) => {
    const reason = hostProblem && link.engine === "claude" && link.profile !== undefined ? hostProblem(`${where}[${index}]: profile "${link.profile}"`, link.profile) : undefined
    return reason ? [reason] : []
  })
}

/** {@link rowProblemsAgainst}, with the host reasons added under their rows. */
export function rowProblemsWithHost(
  where: string,
  links: FallbackLink[],
  ctx: ChainContext,
  selves: readonly FallbackLink[],
  hostProblem: HostProblem | undefined,
): { byRow: string[][]; general: string[] } {
  const found = rowProblemsAgainst(where, links, ctx, selves)
  const host = hostRowProblems(where, links, hostProblem)
  return { ...found, byRow: found.byRow.map((row, i) => [...row, ...host[i]]) }
}
