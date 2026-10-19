import {
  fallbackChainProblems,
  type FallbackChainContext,
  type FallbackLink,
} from "@jinn/fallback-chain-wire"
import { accountEntriesFor, accountNames, chainEntriesFor, type EnginesConfig } from "./chain-model"
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
  const ctx = { engines: names, profiles: new Set(accountNames(engines)) }
  const before = new Map(chainsOf(loaded, names).map(({ where, chain }) => [where, JSON.stringify(chain)]))
  const problems = chainsOf(engines, names)
    // A chain this edit did not change is the gateway's to report, not a reason to refuse an unrelated save.
    .filter(({ where, chain }) => loaded === undefined || before.get(where) !== JSON.stringify(chain))
    .flatMap(({ where, chain, self }) => fallbackChainProblems(where, chain, { ...ctx, self }))
  return problems.length > 0 ? `Cannot save: ${problems.join("; ")}` : null
}
