import type React from "react"
import { ChevronDown, ChevronUp, GripVertical, X } from "@/components/ui/icon"
import { CONTROL_CLASS } from "../shared"
import { moveInChain, removeFromChain } from "./chain-model"
import { engineDisplayName } from "@/lib/engine-names"
import { rowShift, useChainDrag } from "./use-chain-drag"

const ROW_BUTTON_CLASS =
  "grid size-[34px] shrink-0 place-items-center rounded-[8px] border-none bg-transparent " +
  "text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] " +
  "hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-30"

function RowButton({ label, disabled, onClick, children }: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={ROW_BUTTON_CLASS}>
      {children}
    </button>
  )
}

/** One engine in the chain: its place in the order, and the three ways to
 *  change that place without a pointer. */
function ChainRow({ engine, name, index, count, style, onPointerDown, onMove, onRemove }: {
  engine: string
  name: string
  index: number
  count: number
  style: React.CSSProperties
  onPointerDown: (event: React.PointerEvent) => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const label = engineDisplayName(name)
  const chain = `${engineDisplayName(engine)} chain`
  return (
    <div
      data-chain-row={name}
      onPointerDown={onPointerDown}
      style={style}
      className="flex items-center gap-[var(--space-1)] rounded-[10px] bg-[var(--fill-tertiary)] py-[3px] pl-[var(--space-2)] pr-[3px]"
    >
      <GripVertical size={14} aria-hidden className="shrink-0 cursor-grab text-[var(--text-quaternary)]" />
      <span className="w-[14px] shrink-0 text-[length:var(--text-caption2)] text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums]">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] text-[var(--text-primary)]">
        {label}
      </span>
      <RowButton label={`Move ${label} earlier in the ${chain}`} disabled={index === 0} onClick={() => onMove(index - 1)}>
        <ChevronUp size={15} aria-hidden />
      </RowButton>
      <RowButton label={`Move ${label} later in the ${chain}`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
        <ChevronDown size={15} aria-hidden />
      </RowButton>
      <RowButton label={`Remove ${label} from the ${chain}`} onClick={onRemove}>
        <X size={15} aria-hidden />
      </RowButton>
    </div>
  )
}

/** A picker rather than a field: the options are already the only valid ones,
 *  so a chain the gateway would refuse cannot be typed in. */
function AddEngineControl({ engine, options, onAdd }: {
  engine: string
  options: string[]
  onAdd: (name: string) => void
}) {
  return (
    <select
      value=""
      aria-label={`Add an engine to the ${engineDisplayName(engine)} chain`}
      onChange={(event) => { if (event.target.value) onAdd(event.target.value) }}
      className={`${CONTROL_CLASS} mt-[var(--space-2)] cursor-pointer text-[var(--text-tertiary)] sm:w-[220px]`}
    >
      <option value="">Add an engine</option>
      {options.map((name) => (
        <option key={name} value={name}>{engineDisplayName(name)}</option>
      ))}
    </select>
  )
}

/** The ordered chain: drag a row by its grip, or move it with the buttons a
 *  keyboard reaches. */
export function ChainEditor({ engine, chain, options, onChange }: {
  engine: string
  chain: string[]
  options: string[]
  onChange: (chain: string[]) => void
}) {
  const { drag, listRef, liftPointerDown, reducedMotion } = useChainDrag(
    (from, to) => onChange(moveInChain(chain, from, to)),
  )

  return (
    <div className="mt-[var(--space-2)]">
      {chain.length === 0 ? (
        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          No fallback. {engineDisplayName(engine)} waits for its own limit to reset.
        </p>
      ) : (
        <div ref={listRef} className="flex flex-col gap-[var(--space-1)]">
          {chain.map((name, index) => {
            const lifted = drag?.from === index
            return (
              <ChainRow
                key={name}
                engine={engine}
                name={name}
                index={index}
                count={chain.length}
                style={{
                  transform: `translateY(${lifted ? drag.offsetY : rowShift(drag, index)}px)`
                    + (lifted && !reducedMotion ? " scale(1.02)" : ""),
                  transition: drag ? "none" : "transform var(--duration-fast) var(--ease-smooth)",
                  boxShadow: lifted ? "var(--shadow-overlay)" : undefined,
                  position: lifted ? "relative" : undefined,
                  zIndex: lifted ? 1 : undefined,
                  touchAction: "none",
                }}
                onPointerDown={(event) => liftPointerDown(event, index)}
                onMove={(to) => onChange(moveInChain(chain, index, to))}
                onRemove={() => onChange(removeFromChain(chain, index))}
              />
            )
          })}
        </div>
      )}
      {options.length > 0 && (
        <AddEngineControl engine={engine} options={options} onAdd={(name) => onChange([...chain, name])} />
      )}
    </div>
  )
}
