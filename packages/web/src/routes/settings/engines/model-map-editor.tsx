import { useState } from "react"
import { Plus, X } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SettingsSelect } from "../shared"
import { ROW_BUTTON_CLASS } from "./chain-editor"
import { engineDisplayName } from "@/lib/engine-names"
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
    <div className="min-w-0 flex-1">
      <SettingsSelect
        ariaLabel={label}
        value={value}
        onChange={onChange}
        options={offered.length === 0 ? [{ value: "", label: "No models to map onto" }] : offered.map((id) => ({ value: id, label: id }))}
      />
    </div>
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
          label={`Model ${from} runs as on the ${engineDisplayName(engine)} stand-in`}
          value={to}
          options={targets}
          onChange={onRetarget}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove the mapping for ${from} from ${engineDisplayName(engine)}`}
          onClick={onRemove}
          className={ROW_BUTTON_CLASS}
        >
          <X size={15} aria-hidden />
        </Button>
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
      <Button type="submit" variant="secondary" size="sm" disabled={!ready}>
        Add mapping
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
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
  const label = engineDisplayName(engine)

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
        <Input
          aria-label={`Model to carry off ${label}`}
          list={listId}
          value={from}
          placeholder="Model id"
          onChange={(event) => setFrom(event.target.value)}
          className="min-w-0 flex-1"
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
          ? `Any model not listed runs on ${engineDisplayName(substitute)}'s own default${floorModel ? ` (${floorModel})` : ""}.`
          : `${engineDisplayName(engine)} has no fallback chain, so these mappings have no effect until it does.`}
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
        <Button variant="secondary" size="sm" className="mt-[var(--space-2)]" onClick={() => setAdding(true)}>
          <Plus size={14} aria-hidden />
          Add a model mapping
        </Button>
      )}
    </div>
  )
}
