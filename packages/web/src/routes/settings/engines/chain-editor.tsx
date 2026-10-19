import type React from "react"
import type { FallbackLink } from "@jinn/fallback-chain-wire"
import { Plus } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { engineDisplayName } from "@/lib/engine-names"
import { blankLink, moveLink, removeLink, replaceLink, type ChainContext } from "./chain-links"
import { rowProblems, validatorContext } from "./chain-problems"
import { ChainRow, type RowFields } from "./chain-row"
import { rowShift, useChainDrag } from "./use-chain-drag"

export { ROW_BUTTON_CLASS } from "./chain-row"

export interface ChainEditorProps {
  /** Names the chain in every control: "Claude chain", "Claude · work chain". */
  chainName: string
  /** The engine the chain falls back from. */
  ownEngine: string
  /** The target the chain falls back from, which a link may not repeat. */
  self: FallbackLink | undefined
  /** Where the chain is written, so a refusal names it as the config loader would. */
  where: string
  links: FallbackLink[]
  /** Per row: expanded from another entry's own chain. */
  expanded: boolean[]
  fields: Omit<RowFields, "chainName" | "ownEngine">
  /** The empty-chain sentence's subject: what waits for its own limit. */
  waitsAs: string
  /** The gateway's own sentences about this chain; those the editor does not already show are added. */
  serverProblems?: string[]
  onChange: (links: FallbackLink[]) => void
}

function dragStyle(drag: ReturnType<typeof useChainDrag>["drag"], index: number, reducedMotion: boolean): React.CSSProperties {
  const lifted = drag?.from === index
  return {
    transform: `translateY(${lifted ? drag.offsetY : rowShift(drag, index)}px)` + (lifted && !reducedMotion ? " scale(1.02)" : ""),
    transition: drag ? "none" : "transform var(--duration-fast) var(--ease-smooth)",
    boxShadow: lifted ? "var(--shadow-overlay)" : undefined,
    position: lifted ? "relative" : undefined,
    zIndex: lifted ? 1 : undefined,
    touchAction: "none",
  }
}

/** The chain's own sentences that name no row (a chain that is not a list). */
function GeneralProblems({ problems }: { problems: string[] }) {
  return (
    <>
      {problems.map((problem) => (
        <p key={problem} data-chain-problem role="alert" className="mt-[var(--space-1)] text-[length:var(--text-caption2)]" style={{ color: "var(--system-red)" }}>
          {problem}
        </p>
      ))}
    </>
  )
}

/** The ordered chain: engine, profile and model per link; drag a row by its grip,
 *  or move it with the buttons a keyboard reaches. A problem shows under its row. */
export function ChainEditor(props: ChainEditorProps) {
  const { chainName, ownEngine, self, where, links, expanded, fields, waitsAs, serverProblems = [], onChange } = props
  const { drag, listRef, liftPointerDown, reducedMotion } = useChainDrag((from, to) => onChange(moveLink(links, from, to)))
  const ctx: ChainContext = {
    engines: Object.values(fields.registry.engines),
    profiles: fields.profiles,
  }
  const problems = rowProblems(where, links, validatorContext(ctx, self))
  const rowFields: RowFields = { ...fields, ownEngine, chainName }

  return (
    <div className="@container/chain mt-[var(--space-2)]">
      {links.length === 0 ? (
        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          No fallback. {waitsAs} waits for its own limit to reset.
        </p>
      ) : (
        <div ref={listRef} className="flex flex-col gap-[var(--space-1)]">
          {links.map((link, index) => (
            <ChainRow
              key={index}
              link={link}
              index={index}
              count={links.length}
              fields={rowFields}
              problems={problems.byRow[index]}
              expanded={expanded[index] ?? false}
              style={dragStyle(drag, index, reducedMotion)}
              onPointerDown={(event) => liftPointerDown(event, index)}
              onChange={(next) => onChange(replaceLink(links, index, next))}
              onMove={(to) => onChange(moveLink(links, index, to))}
              onRemove={() => onChange(removeLink(links, index))}
            />
          ))}
        </div>
      )}
      <GeneralProblems problems={[...problems.general, ...serverProblems.filter((p) => !problems.byRow.flat().includes(p))]} />
      <Button
        variant="secondary"
        size="sm"
        className="mt-[var(--space-2)]"
        aria-label={`Add a target to the ${chainName}`}
        onClick={() => onChange([...links, blankLink(ctx, links, self)])}
      >
        <Plus size={14} aria-hidden />
        Add a fallback target
      </Button>
    </div>
  )
}

/** "Claude chain"; with an account, "Claude · work chain". */
export function chainNameOf(engine: string, account?: string): string {
  return `${[engineDisplayName(engine), account].filter(Boolean).join(" · ")} chain`
}
