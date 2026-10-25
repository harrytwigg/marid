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

function RowButton({ label, move, disabled, onClick, children }: {
  label: string
  /** Which way the button moves its row, so focus can be put back on it after the move. */
  move?: "earlier" | "later"
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} data-chain-move={move} disabled={disabled} onClick={onClick} className={ROW_BUTTON_CLASS}>
      {children}
    </Button>
  )
}

/** What a row's three fields draw their options from, and what they are called. */
export interface RowFields {
  registry: EnginesResponse
  profiles: string[]
  /** The names a link may carry without being flagged unknown, when that is more than the picker offers (default: `profiles`). */
  knownProfiles?: string[]
  /** How the picker names an account that is not just its name (a remote one carries its host). */
  profileLabels?: Record<string, string>
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
  const offered = profileOptionsFor(link.engine, fields.profiles, fields.profileLabels)
  // A stored profile this chain is not offered (a remote account, in a chain on the gateway's own side) stays selectable as written, so the select shows it.
  const profiles = offered && link.profile && !offered.some((o) => o.value === link.profile) ? [...offered, { value: link.profile, label: link.profile }] : offered
  return (
    <div className="flex w-full min-w-0 flex-col gap-[var(--space-1)] @[560px]/chain:flex-1 @[560px]/chain:flex-row @[560px]/chain:items-center">
      <div className="min-w-0 @[560px]/chain:w-[28%] @[560px]/chain:min-w-[7.5rem] @[560px]/chain:shrink-0">
        <SettingsSelect
          value={link.engine}
          ariaLabel={`Engine of ${at}`}
          onChange={(engine) => onChange(withEngine(link, engine))}
          options={Object.values(fields.registry.engines).map((e) => ({ value: e.name, label: engineDisplayName(e.name) }))}
        />
      </div>
      {profiles && (
        <div className="min-w-0 @[560px]/chain:w-[24%] @[560px]/chain:min-w-[5rem] @[560px]/chain:shrink-0">
          <SettingsSelect
            value={link.profile ?? ""}
            ariaLabel={`Profile of ${at}`}
            onChange={(profile) => onChange(withProfile(link, profile))}
            options={profiles}
          />
        </div>
      )}
      <div className="min-w-0 @[560px]/chain:flex-1">
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

/** The three ways to change a row's place without a pointer. */
function RowActions({ label, chainName, index, count, onMove, onRemove }: {
  label: string
  chainName: string
  index: number
  count: number
  onMove: (to: number) => void
  onRemove: () => void
}) {
  return (
    <>
      <RowButton label={`Move ${label} earlier in the ${chainName}`} move="earlier" disabled={index === 0} onClick={() => onMove(index - 1)}>
        <ChevronUp size={15} aria-hidden />
      </RowButton>
      <RowButton label={`Move ${label} later in the ${chainName}`} move="later" disabled={index === count - 1} onClick={() => onMove(index + 1)}>
        <ChevronDown size={15} aria-hidden />
      </RowButton>
      <RowButton label={`Remove ${label} from the ${chainName}`} onClick={onRemove}>
        <X size={15} aria-hidden />
      </RowButton>
    </>
  )
}

/** One link in the chain: its place in the order, the target it names, and the
 *  three ways to change that place without a pointer. */
export function ChainRow({ rowId, link, index, count, fields, problems, expanded, style, onPointerDown, onChange, onMove, onRemove }: {
  /** Stable across moves and edits: see `useRowIds`. */
  rowId: string
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
        data-row-id={rowId}
        data-invalid={problems.length > 0 || undefined}
        onPointerDown={onPointerDown}
        style={style}
        className="flex flex-wrap items-center gap-[var(--space-1)] rounded-[10px] bg-[var(--fill-tertiary)] py-[3px] pl-[var(--space-2)] pr-[3px] @[560px]/chain:flex-nowrap"
      >
        {/* The one part of a row that owns a touch: everywhere else a swipe scrolls the page. */}
        <span data-chain-grip aria-hidden className="grid size-[28px] shrink-0 cursor-grab place-items-center text-[var(--text-quaternary)]" style={{ touchAction: "none" }}>
          <GripVertical size={14} />
        </span>
        <span className="w-[14px] shrink-0 text-[length:var(--text-caption2)] text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums]">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 @[560px]/chain:hidden" />
        <div className="order-last flex w-full @[560px]/chain:order-none @[560px]/chain:contents">
          <RowTarget link={link} index={index} fields={fields} onChange={onChange} />
        </div>
        <RowActions label={label} chainName={fields.chainName} index={index} count={count} onMove={onMove} onRemove={onRemove} />
      </div>
      {expanded && <ExpandedNote />}
      {problems.map((problem) => (
        <p key={problem} data-chain-problem role="alert" className="px-[var(--space-2)] text-[length:var(--text-caption2)]" style={{ color: "var(--system-red)" }}>
          {problem}
        </p>
      ))}
    </div>
  )
}

/** Marks a link that runs because another entry's own chain expanded to it. */
function ExpandedNote() {
  return (
    <p data-chain-expanded className="m-0 px-[var(--space-2)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
      From another chain: saving writes it as a link of this one.
    </p>
  )
}
