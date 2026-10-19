import type React from "react"
import { ChevronDown, ChevronUp, GripVertical, X } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { SettingsSelect } from "../shared"
import { moveInChain, removeFromChain } from "./chain-model"
import { engineDisplayName } from "@/lib/engine-names"
import { rowShift, useChainDrag } from "./use-chain-drag"

/** A row's icon button: ghost, at the 34px the rows are laid out for. */
export const ROW_BUTTON_CLASS = "size-[34px] min-h-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"

function RowButton({ label, disabled, onClick, children }: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick} className={ROW_BUTTON_CLASS}>
      {children}
    </Button>
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
    <div className="mt-[var(--space-2)] sm:w-[220px]">
      <SettingsSelect
        value=""
        ariaLabel={`Add an engine to the ${engineDisplayName(engine)} chain`}
        onChange={(name) => { if (name) onAdd(name) }}
        options={[{ value: "", label: "Add an engine" }, ...options.map((name) => ({ value: name, label: engineDisplayName(name) }))]}
      />
    </div>
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
