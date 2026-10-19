import type React from "react"
import { fallbackLinkLabel, type FallbackLink } from "@jinn/fallback-chain-wire"
import { ChevronDown, ChevronUp, GripVertical, X } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { SettingsSelect } from "../shared"
import type { EnginesResponse } from "@/lib/api"
import { engineDisplayName } from "@/lib/engine-names"
import { ChainModelSelect } from "./chain-model-select"
import { noModelLabel, profileOptionsFor, rowLabel, withEngine, withModel, withProfile } from "./chain-links"

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

/** What a row's three fields draw their options from, and what they are called. */
export interface RowFields {
  registry: EnginesResponse
  profiles: string[]
  /** The engine the chain falls back from: where "Same model" is meant. */
  ownEngine: string | undefined
  /** "Claude chain", "Claude · work chain": names the chain in every control. */
  chainName: string
}

/** Engine, then profile (Claude only), then model: one target. */
function RowTarget({ link, index, fields, onChange }: {
  link: FallbackLink
  index: number
  fields: RowFields
  onChange: (link: FallbackLink) => void
}) {
  const at = `link ${index + 1} of the ${fields.chainName}`
  const profiles = profileOptionsFor(link.engine, fields.profiles)
  return (
    <div className="flex w-full min-w-0 flex-col gap-[var(--space-1)] sm:flex-1 sm:flex-row sm:items-center">
      <div className="min-w-0 sm:w-[28%] sm:shrink-0">
        <SettingsSelect
          value={link.engine}
          ariaLabel={`Engine of ${at}`}
          onChange={(engine) => onChange(withEngine(link, engine))}
          options={Object.values(fields.registry.engines).map((e) => ({ value: e.name, label: engineDisplayName(e.name) }))}
        />
      </div>
      {profiles && (
        <div className="min-w-0 sm:w-[24%] sm:shrink-0">
          <SettingsSelect
            value={link.profile ?? ""}
            ariaLabel={`Profile of ${at}`}
            onChange={(profile) => onChange(withProfile(link, profile))}
            options={profiles}
          />
        </div>
      )}
      <div className="min-w-0 sm:flex-1">
        <ChainModelSelect
          registry={fields.registry}
          engine={link.engine}
          value={link.model ?? ""}
          noModelText={noModelLabel(link.engine, fields.ownEngine)}
          ariaLabel={`Model of ${at}`}
          onChange={(model) => onChange(withModel(link, model))}
        />
      </div>
    </div>
  )
}

/** One link in the chain: its place in the order, the target it names, and the
 *  three ways to change that place without a pointer. */
export function ChainRow({ link, index, count, fields, problems, expanded, style, onPointerDown, onChange, onMove, onRemove }: {
  link: FallbackLink
  index: number
  count: number
  fields: RowFields
  /** The validator's sentences for this row. */
  problems: string[]
  /** The link was expanded from another entry's own chain, not written here. */
  expanded: boolean
  style: React.CSSProperties
  onPointerDown: (event: React.PointerEvent) => void
  onChange: (link: FallbackLink) => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const label = rowLabel(link)
  return (
    <div className="flex flex-col gap-[2px]">
      <div
        data-chain-row={fallbackLinkLabel(link)}
        data-invalid={problems.length > 0 || undefined}
        onPointerDown={onPointerDown}
        style={style}
        className="flex flex-wrap items-center gap-[var(--space-1)] rounded-[10px] bg-[var(--fill-tertiary)] py-[3px] pl-[var(--space-2)] pr-[3px] sm:flex-nowrap"
      >
        <GripVertical size={14} aria-hidden className="shrink-0 cursor-grab text-[var(--text-quaternary)]" />
        <span className="w-[14px] shrink-0 text-[length:var(--text-caption2)] text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums]">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 sm:hidden" />
        {expanded && <ExpandedBadge />}
        <div className="order-last flex w-full sm:order-none sm:contents">
          <RowTarget link={link} index={index} fields={fields} onChange={onChange} />
        </div>
        <RowButton label={`Move ${label} earlier in the ${fields.chainName}`} disabled={index === 0} onClick={() => onMove(index - 1)}>
          <ChevronUp size={15} aria-hidden />
        </RowButton>
        <RowButton label={`Move ${label} later in the ${fields.chainName}`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>
          <ChevronDown size={15} aria-hidden />
        </RowButton>
        <RowButton label={`Remove ${label} from the ${fields.chainName}`} onClick={onRemove}>
          <X size={15} aria-hidden />
        </RowButton>
      </div>
      {problems.map((problem) => (
        <p key={problem} data-chain-problem role="alert" className="px-[var(--space-2)] text-[length:var(--text-caption2)]" style={{ color: "var(--system-red)" }}>
          {problem}
        </p>
      ))}
    </div>
  )
}

/** Marks a link that runs because another entry's own chain expanded to it. */
function ExpandedBadge() {
  return (
    <span
      data-chain-expanded
      title="Expanded from another entry's own chain; saving writes it as a link of this chain"
      className="shrink-0 rounded-[5px] bg-[var(--fill-secondary)] px-1 py-px text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
    >
      from another chain
    </span>
  )
}
