import { ExternalLink } from "@/components/ui/icon"
import type { WorkItemTreeWire } from "@/lib/api"
import { stateKeyOf } from "@/lib/todos"
import { StateCircle } from "../state-glyph"
import { rollupOf } from "./card"
import type { SubBoardDepth } from "./board-route"

/* The strip that heads a sub-board in place of the board's title: the root Todo (id, state, title, roll-up and
 * a way to open it) and the depth toggle. It is a strip, not a card: the root is not one of the board's Todos,
 * so it has no column and cannot be dragged. The toggle is two native radios in HeroUI's tabs classes, as the
 * phone's Board | List switch is (board-view-switch.tsx): arrow keys for free, no tabs runtime in the chunk. */

const DEPTHS: readonly { id: SubBoardDepth; label: string }[] = [
  { id: "children", label: "Children" },
  { id: "all", label: "All levels" },
]

function DepthToggle({ value, onChange }: { value: SubBoardDepth; onChange: (depth: SubBoardDepth) => void }) {
  return (
    <div className="tabs" data-orientation="horizontal">
      <div className="tabs__list-container">
        <div role="radiogroup" aria-label="Sub-board depth" className="tabs__list" data-orientation="horizontal" data-testid="sub-board-depth">
          {DEPTHS.map((depth) => (
            <label
              key={depth.id}
              className="tabs__tab h-9 min-w-20 cursor-pointer whitespace-nowrap"
              data-selected={value === depth.id}
              data-testid={`sub-board-depth-${depth.id}`}
            >
              <input
                type="radio"
                name="sub-board-depth"
                value={depth.id}
                checked={value === depth.id}
                onChange={() => onChange(depth.id)}
                className="sr-only"
              />
              {depth.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

function RootLine({ rootId, tree, missing, onOpenRoot }: {
  rootId: string
  tree: WorkItemTreeWire | undefined
  missing: boolean
  onOpenRoot: () => void
}) {
  const root = tree?.root
  const rollup = rollupOf(tree, root?.status ?? "backlog")
  return (
    <div className="flex min-w-0 flex-1 basis-64 items-center gap-2.5">
      {root && <StateCircle keyOf={stateKeyOf(root.status)} size={18} className="flex-none" />}
      <span
        className="flex-none text-[calc(12px*var(--text-scale))] tracking-[.04em] text-[var(--text-tertiary)]"
        style={{ fontFamily: "var(--font-code)" }}
        data-testid="sub-board-root-id"
      >
        {rootId}
      </span>
      <h2
        data-testid="sub-board-root-title"
        className="min-w-0 truncate text-[calc(17px*var(--text-scale))] font-semibold text-[var(--text-primary)]"
      >
        {root?.title ?? (missing ? "This Todo is not available" : "")}
      </h2>
      {rollup && (
        <span data-testid="sub-board-rollup" className="flex-none text-[calc(12px*var(--text-scale))] tabular-nums text-[var(--text-tertiary)]">
          {rollup.closed}/{rollup.total} done
        </span>
      )}
      <button
        type="button"
        onClick={onOpenRoot}
        data-testid="sub-board-open-root"
        className="focus-outline flex h-8 flex-none items-center gap-1.5 rounded-full px-2.5 text-[calc(12px*var(--text-scale))] font-medium text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--fill-tertiary)]"
      >
        <ExternalLink size={13} aria-hidden />
        Open
      </button>
    </div>
  )
}

export function SubBoardHeader({
  depth,
  onDepth,
  ...root
}: {
  rootId: string
  tree: WorkItemTreeWire | undefined
  /** The root Todo could not be read: unknown, or not one this person may see. */
  missing: boolean
  depth: SubBoardDepth
  onDepth: (depth: SubBoardDepth) => void
  onOpenRoot: () => void
}) {
  return (
    <div data-testid="sub-board-header" className="flex flex-wrap items-center gap-x-4 gap-y-2 pr-10 max-[700px]:pr-12">
      <RootLine {...root} />
      <DepthToggle value={depth} onChange={onDepth} />
    </div>
  )
}
