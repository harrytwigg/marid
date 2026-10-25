import { useLayoutEffect, useRef, type CSSProperties } from "react"
import type { FallbackLink } from "@jinn/fallback-chain-wire"
import { Plus } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { engineDisplayName } from "@/lib/engine-names"
import { blankLink, moveLink, removeLink, replaceLink, selfSpellings, type ChainContext } from "./chain-links"
import { rowProblemsWithHost, type HostProblem } from "./chain-problems"
import { ChainRow, type RowFields } from "./chain-row"
import { rowShift, useChainDrag } from "./use-chain-drag"
import { useRowIds } from "./use-row-ids"

export { ROW_BUTTON_CLASS } from "./chain-row"

export interface ChainEditorProps {
  /** Names the chain in every control: "Claude chain", "Claude · work chain". */
  chainName: string
  /** The engine the chain falls back from. */
  ownEngine: string
  /** The target the chain falls back from, which a link may not repeat. */
  /** Every spelling of it the gateway refuses: an employee's, with its model and without. */
  self: FallbackLink | readonly FallbackLink[] | undefined
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
  /** Why a declared account is the wrong side for this chain's employee, in the gateway's words; the validator alone calls such a name unknown. */
  hostProblem?: HostProblem
  onChange: (links: FallbackLink[]) => void
}

function dragStyle(drag: ReturnType<typeof useChainDrag>["drag"], index: number, reducedMotion: boolean): CSSProperties {
  const lifted = drag?.from === index
  return {
    transform: `translateY(${lifted ? drag.offsetY : rowShift(drag, index)}px)` + (lifted && !reducedMotion ? " scale(1.02)" : ""),
    transition: drag ? "none" : "transform var(--duration-fast) var(--ease-smooth)",
    boxShadow: lifted ? "var(--shadow-overlay)" : undefined,
    position: lifted ? "relative" : undefined,
    zIndex: lifted ? 1 : undefined,
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

/** The chain's own sentences, then the gateway's that the editor is not already showing (under a row or among its own), each once. */
function unshownProblems(own: { byRow: string[][]; general: string[] }, serverProblems: string[]): string[] {
  const shown = new Set([...own.byRow.flat(), ...own.general])
  return [...own.general, ...new Set(serverProblems.filter((problem) => !shown.has(problem)))]
}

/** What a reorder does, kept together: the links, the ids that travel with the rows, and where focus goes. */
function useChainMoves(links: FallbackLink[], onChange: (links: FallbackLink[]) => void) {
  const rows = useRowIds(links.length)
  const focusAfter = useRef<{ id: string; dir: "earlier" | "later" } | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // A moved row keeps the focus its operator gave it, so a second press moves it again.
  useLayoutEffect(() => {
    const target = focusAfter.current
    focusAfter.current = null
    const row = target ? listRef.current?.querySelector(`[data-row-id="${target.id}"]`) : null
    const button = row?.querySelector<HTMLButtonElement>(`[data-chain-move="${target?.dir}"]:not(:disabled)`)
      ?? row?.querySelector<HTMLButtonElement>("[data-chain-move]:not(:disabled)")
    button?.focus()
  })
  const move = (from: number, to: number) => {
    rows.moved(from, to)
    onChange(moveLink(links, from, to))
  }
  return {
    ids: rows.ids,
    listRef,
    move,
    moveByButton: (from: number, to: number) => {
      focusAfter.current = { id: rows.ids[from], dir: to > from ? "later" : "earlier" }
      move(from, to)
    },
    remove: (index: number) => {
      rows.removed(index)
      onChange(removeLink(links, index))
    },
  }
}

/** The ordered chain: engine, profile and model per link; drag a row by its grip,
 *  or move it with the buttons a keyboard reaches. A problem shows under its row. */
export function ChainEditor(props: ChainEditorProps) {
  const { chainName, ownEngine, self, where, links, expanded, fields, waitsAs, serverProblems = [], hostProblem, onChange } = props
  const moves = useChainMoves(links, onChange)
  const { drag, listRef, liftPointerDown, reducedMotion } = useChainDrag(moves.move)
  const ctx: ChainContext = { engines: Object.values(fields.registry.engines), profiles: fields.knownProfiles ?? fields.profiles }
  const selves = selfSpellings(self)
  const problems = rowProblemsWithHost(where, links, ctx, selves, hostProblem)
  const rowFields: RowFields = { ...fields, ownEngine, chainName }

  return (
    <div className="@container/chain mt-[var(--space-2)]">
      {links.length === 0 ? (
        <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          No fallback. {waitsAs} waits for its own limit to reset.
        </p>
      ) : (
        <div ref={(el) => { listRef.current = el; moves.listRef.current = el }} className="flex flex-col gap-[var(--space-1)]">
          {links.map((link, index) => (
            <ChainRow
              key={moves.ids[index]}
              rowId={moves.ids[index]}
              link={link}
              index={index}
              count={links.length}
              fields={rowFields}
              problems={problems.byRow[index]}
              expanded={expanded[index] ?? false}
              style={dragStyle(drag, index, reducedMotion)}
              onPointerDown={(event) => liftPointerDown(event, index)}
              onChange={(next) => onChange(replaceLink(links, index, next))}
              onMove={(to) => moves.moveByButton(index, to)}
              onRemove={() => moves.remove(index)}
            />
          ))}
        </div>
      )}
      <GeneralProblems problems={unshownProblems(problems, serverProblems)} />
      <Button
        variant="secondary"
        size="sm"
        className="mt-[var(--space-2)]"
        aria-label={`Add a target to the ${chainName}`}
        onClick={() => onChange([...links, blankLink(ctx, links, selves)])}
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
