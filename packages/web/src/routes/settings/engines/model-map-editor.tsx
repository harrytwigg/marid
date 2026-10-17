import { useState } from "react"
import { Plus, X } from "@/components/ui/icon"
import { cn } from "@/lib/utils"
import { CONTROL_CLASS } from "../shared"
import { engineLabel } from "./chain-model"
import {
  addMapPair,
  firstSubstitute,
  mapPairProblem,
  removeMapPair,
  setMapTarget,
  sourceOptionsFor,
  targetOptionsFor,
  type MapContext,
  type ModelMapPair,
  type ServedModels,
} from "./model-map-model"

const ROW_BUTTON_CLASS =
  "grid size-[34px] shrink-0 place-items-center rounded-[8px] border-none bg-transparent " +
  "text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] " +
  "hover:text-[var(--text-primary)]"

const LABEL_CLASS = "text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"

/** A target picker that can always show what is already configured. An entry
 *  reordered out of validity still has to be readable and fixable, so the value
 *  on the row is offered alongside the options even when it is not one of them. */
function TargetSelect({ label, value, options, onChange }: {
  label: string
  value: string
  options: string[]
  onChange: (target: string) => void
}) {
  const offered = value && !options.includes(value) ? [value, ...options] : options
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(CONTROL_CLASS, "h-[34px] min-w-0 flex-1 cursor-pointer")}
    >
      {offered.length === 0 && <option value="">No models to map onto</option>}
      {offered.map((id) => <option key={id} value={id}>{id}</option>)}
    </select>
  )
}

/** One configured translation: the pin on the left, what the stand-in runs on the
 *  right, and the loader's own sentence underneath when the pair cannot fire. */
function MapRow({ engine, from, to, targets, problem, onRetarget, onRemove }: {
  engine: string
  from: string
  to: string
  targets: string[]
  problem: string | null
  onRetarget: (target: string) => void
  onRemove: () => void
}) {
  return (
    <div data-model-map-pair={from} className="flex flex-col gap-[2px]">
      <div className="flex items-center gap-[var(--space-1)] rounded-[10px] bg-[var(--fill-tertiary)] py-[3px] pl-[var(--space-2)] pr-[3px]">
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] text-[var(--text-primary)]">
          {from}
        </span>
        <span aria-hidden className="shrink-0 text-[length:var(--text-footnote)] text-[var(--text-quaternary)]">→</span>
        <TargetSelect
          label={`Model ${from} runs as on the ${engineLabel(engine)} stand-in`}
          value={to}
          options={targets}
          onChange={onRetarget}
        />
        <button
          type="button"
          aria-label={`Remove the mapping for ${from} from ${engineLabel(engine)}`}
          onClick={onRemove}
          className={ROW_BUTTON_CLASS}
        >
          <X size={15} aria-hidden />
        </button>
      </div>
      {problem && (
        <p data-model-map-problem={from} className="px-[var(--space-2)] text-[length:var(--text-caption2)]" style={{ color: "var(--system-red)" }}>
          {problem}
        </p>
      )}
    </div>
  )
}

/** Commit or back out. Disabled until both halves are named, because a half-written
 *  row is a mapping that could never fire. */
function AddActions({ ready, onCancel }: { ready: boolean; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-[var(--space-2)]">
      <button
        type="submit"
        disabled={!ready}
        className={cn(CONTROL_CLASS, "h-[34px] w-auto cursor-pointer px-[var(--space-3)] disabled:cursor-not-allowed disabled:opacity-40")}
      >
        Add mapping
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="h-[34px] cursor-pointer border-none bg-transparent px-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
      >
        Cancel
      </button>
    </div>
  )
}

/** The add form: a source that suggests without constraining, and a target that
 *  constrains without suggesting. A model id belongs to one provider, so the
 *  target list is the substitute's and nothing else — but the source may name a
 *  model this gateway's registry has not heard of yet, so it is typed as well as
 *  picked. */
function AddMapping({ engine, sources, targets, onAdd, onCancel }: {
  engine: string
  sources: string[]
  targets: string[]
  onAdd: (from: string, to: string) => void
  onCancel: () => void
}) {
  const [from, setFrom] = useState("")
  const [to, setTo] = useState(targets[0] ?? "")
  const listId = `model-map-sources-${engine}`
  const label = engineLabel(engine)

  return (
    <form
      data-model-map-add={engine}
      className="mt-[var(--space-1)] flex flex-col gap-[var(--space-1)]"
      onSubmit={(event) => {
        event.preventDefault()
        if (from.trim() && to.trim()) onAdd(from, to)
      }}
    >
      <div className="flex items-center gap-[var(--space-1)]">
        <input
          aria-label={`Model to carry off ${label}`}
          list={listId}
          value={from}
          placeholder="Model id"
          onChange={(event) => setFrom(event.target.value)}
          className={cn(CONTROL_CLASS, "h-[34px] min-w-0 flex-1")}
        />
        <datalist id={listId}>
          {sources.map((id) => <option key={id} value={id} />)}
        </datalist>
        <span aria-hidden className="shrink-0 text-[length:var(--text-footnote)] text-[var(--text-quaternary)]">→</span>
        <TargetSelect label={`Model to run as instead, for ${label}`} value={to} options={targets} onChange={setTo} />
      </div>
      <AddActions ready={Boolean(from.trim() && to.trim())} onCancel={onCancel} />
    </form>
  )
}

/** Every configured translation, in the order config.yaml states them. */
function MapRows({ engine, pairs, targets, context, onChange }: {
  engine: string
  pairs: ModelMapPair[]
  targets: string[]
  context: MapContext
  onChange: (pairs: ModelMapPair[]) => void
}) {
  if (pairs.length === 0) return null
  return (
    <div className="mt-[var(--space-1)] flex flex-col gap-[var(--space-1)]">
      {pairs.map(([from, to], index) => (
        <MapRow
          key={`${from}-${index}`}
          engine={engine}
          from={from}
          to={to}
          targets={targets}
          problem={mapPairProblem(context, pairs, index)}
          onRetarget={(target) => onChange(setMapTarget(pairs, index, target))}
          onRemove={() => onChange(removeMapPair(pairs, index))}
        />
      ))}
    </div>
  )
}

/**
 * `engines.<name>.fallbackModelMap`, editable.
 *
 * A model id belongs to exactly one provider, so a pin never survives a swap by
 * default — this map is the only thing that carries one across, and only onto a
 * model the stand-in actually serves. The floor rule stays on screen whether or
 * not anything is mapped, because "nothing happens" is the answer for almost
 * every model and an operator should not have to infer it from an empty list.
 */
export function ModelMapEditor({ engine, chain, pairs, served, defaultModels, onChange }: {
  engine: string
  chain: string[]
  pairs: ModelMapPair[]
  served: ServedModels
  /** Each engine's own default model, so the floor rule can name the one an
   *  unmapped pin actually lands on rather than describing it in the abstract. */
  defaultModels: Record<string, string>
  onChange: (pairs: ModelMapPair[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const substitute = firstSubstitute(chain)
  const targets = targetOptionsFor(served, substitute)
  const context = { engine, substitute, served }
  const floorModel = substitute ? defaultModels[substitute] : undefined

  return (
    <div className="mt-[var(--space-3)]">
      <div className={LABEL_CLASS}>Models carried onto the stand-in</div>
      <MapRows engine={engine} pairs={pairs} targets={targets} context={context} onChange={onChange} />
      <p className={`mt-[var(--space-1)] ${LABEL_CLASS}`} data-model-map-floor={engine}>
        {substitute
          ? `Any model not listed runs on ${engineLabel(substitute)}'s own default${floorModel ? ` (${floorModel})` : ""}.`
          : `${engineLabel(engine)} has no fallback chain, so these mappings have no effect until it does.`}
      </p>
      {adding ? (
        <AddMapping
          engine={engine}
          sources={sourceOptionsFor(served, engine, pairs)}
          targets={targets}
          onAdd={(from, to) => { onChange(addMapPair(pairs, from, to)); setAdding(false) }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={cn(CONTROL_CLASS, "mt-[var(--space-2)] flex h-[34px] w-auto cursor-pointer items-center gap-[6px] px-[var(--space-3)] text-[var(--text-secondary)]")}
        >
          <Plus size={14} aria-hidden />
          Add a model mapping
        </button>
      )}
    </div>
  )
}
