import {
  blankSourceProblem,
  malformedSourceProblem,
  malformedTargetProblem,
  modelMapEntryPath,
  targetNotAModelIdProblem,
  unservedTargetProblem,
} from "@jinn/fallback-map-wire"
import { isSpellableModelId } from "@jinn/model-id"
import { chainSaveBlocker } from "./chain-problems"
import { modelMapFor, substituteChainFor, type EnginesConfig } from "./chain-model"

/** One `from → to` row. A list rather than an object because the editor has to be
 *  able to hold two rows claiming the same source long enough to say so — an
 *  object would collapse them and the operator would watch a row disappear. */
export type ModelMapPair = [string, string]

/** The model ids each engine serves, keyed by engine — the registry reduced to
 *  the single question this editor asks of it. */
export type ServedModels = Record<string, string[]>

/**
 * The engine a turn actually lands on when it falls out of `engine` through a
 * link that names no model: the first such link's engine. The map's targets are
 * judged against what THAT engine serves, so an engine with no chain has nothing to judge its map against —
 * which is also why the editor says the map has no effect rather than hiding it.
 */
export function firstSubstitute(chain: string[]): string | null {
  return chain[0] ?? null
}

/** The targets the editor may offer: exactly what the first substitute serves. */
export function targetOptionsFor(served: ServedModels, substitute: string | null): string[] {
  return substitute ? served[substitute] ?? [] : []
}

/** The sources the picker suggests: models this engine serves that are not mapped
 *  yet. Only a suggestion — a typed id is still accepted, because an operator can
 *  pin a model the registry has not caught up with, and the map keys on the pin. */
export function sourceOptionsFor(served: ServedModels, engine: string, pairs: ModelMapPair[]): string[] {
  const mapped = new Set(pairs.map(([from]) => from))
  return (served[engine] ?? []).filter((id) => !mapped.has(id))
}

export function addMapPair(pairs: ModelMapPair[], from: string, to: string): ModelMapPair[] {
  return [...pairs, [from.trim(), to.trim()]]
}

export function removeMapPair(pairs: ModelMapPair[], index: number): ModelMapPair[] {
  return pairs.filter((_, i) => i !== index)
}

/** Retarget one row, leaving its source and every other row alone. */
export function setMapTarget(pairs: ModelMapPair[], index: number, target: string): ModelMapPair[] {
  return pairs.map((pair, i) => (i === index ? [pair[0], target] : pair))
}

/**
 * What the map becomes on the wire. An emptied map is `null` rather than `{}`:
 * the gateway deep-merges a PUT over the file and keeps every key the PUT omits,
 * so `{}` merges to no change at all and the block would survive being cleared.
 * Only an explicit null deletes it — the same reason `legacyMigrationMutations`
 * nulls the two deprecated keys instead of dropping them.
 */
export function mapConfigValue(pairs: ModelMapPair[]): Record<string, string> | null {
  return pairs.length === 0 ? null : Object.fromEntries(pairs)
}

export interface MapContext {
  engine: string
  substitute: string | null
  served: ServedModels
}

/**
 * What is wrong with one row, worded the way the config loader words it, or null.
 *
 * Spellability is asked before the substitute is consulted at all, because a pasted
 * `id<TAB>label` composite is a nonempty string that no engine serves — judged in
 * the other order it comes back as a target the stand-in does not serve, and that
 * sends the operator to the engine when the fault is the character in the row.
 *
 * A substitute the registry lists no models for is not judged at all: "serves
 * nothing" is what an engine looks like before its registry entry is populated,
 * and refusing every target on that basis would block a save over missing data
 * rather than over a real mistake.
 */
export function mapPairProblem({ engine, substitute, served }: MapContext, pairs: ModelMapPair[], index: number): string | null {
  const [from, to] = pairs[index]
  if (!from.trim()) return blankSourceProblem(engine)
  if (!to.trim()) return targetNotAModelIdProblem(engine, from, to)
  if (!isSpellableModelId(from)) return malformedSourceProblem(engine, from)
  if (!isSpellableModelId(to)) return malformedTargetProblem(engine, from, to)
  if (pairs.findIndex(([other]) => other === from) !== index) {
    return `${modelMapEntryPath(engine, from)} is set twice — a model can only be carried onto one stand-in`
  }
  if (!substitute) return null
  const models = served[substitute] ?? []
  if (models.length === 0 || models.includes(to)) return null
  return unservedTargetProblem({ engine, model: from, target: to, substitute })
}

/** Every problem on one engine's map, in row order. */
export function mapProblems(context: MapContext, pairs: ModelMapPair[]): string[] {
  return pairs.map((_, index) => mapPairProblem(context, pairs, index)).filter((p): p is string => p !== null)
}

/**
 * Every `fallbackModelMap` problem in the whole config. The write path reads this
 * before it PUTs, so a document the gateway's loader would refuse never reaches
 * the file — the editor and the loader disagree about nothing.
 */
export function allModelMapProblems(engines: EnginesConfig | undefined, served: ServedModels): string[] {
  return Object.keys(served).flatMap((engine) =>
    mapProblems(
      { engine, substitute: firstSubstitute(substituteChainFor(engines, engine)), served },
      modelMapFor(engines, engine),
    ),
  )
}

/**
 * Why this config cannot be saved yet, or null.
 *
 * The gateway refuses these too, but only after the whole document has made the
 * trip. Asking here gets the operator the same sentence sooner, and keeps a
 * document the config loader would reject off the wire entirely. Chains are asked
 * first: a map is judged against the chain it hangs from.
 */
export function configSaveBlocker(
  engines: EnginesConfig | undefined,
  registryEngines: Record<string, { name: string; models: { id: string }[] }> | undefined,
): string | null {
  const chainBlocker = chainSaveBlocker(engines, registryEngines)
  if (chainBlocker) return chainBlocker
  const served: ServedModels = Object.fromEntries(
    Object.values(registryEngines ?? {}).map((engine) => [engine.name, engine.models.map((model) => model.id)]),
  )
  const problems = allModelMapProblems(engines, served)
  return problems.length > 0 ? `Cannot save: ${problems.join("; ")}` : null
}
