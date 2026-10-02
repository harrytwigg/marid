import { Zap } from "lucide-react"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import type { DepartmentSummaryWire } from "@/lib/api"
import type { BoardId } from "./board-route"
import { BoardSwitcher } from "./board-switcher"

type BoardCounts = {
  isAttention: boolean
  attentionCount: number
  openCount: number
  blockedTotal: number
}

type BoardHeaderProps = BoardCounts & {
  board: BoardId
  title: string
  departments: DepartmentSummaryWire[] | undefined
  deptPrefix: string | undefined
  onQuickCapture: () => void
}

function Dot() {
  return <span aria-hidden className="size-[2.5px] rounded-full bg-[var(--text-quaternary)]" />
}

/**
 * Quick capture is the cheap way onto the board — a rough sentence thrown at the
 * system — so it rides the title bar as a quiet secondary control. `New Todo`
 * opens the full form and keeps the accent, and it reaches the same bar through
 * the scaffold's primary-action slot; the two are deliberately not the same
 * weight.
 */
function QuickCaptureButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="todo-quick-capture"
      onClick={onClick}
      aria-label="Quick capture"
      title="Quick capture — type or dictate a rough idea"
      className="focus-ring inline-flex size-10 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-ambient),var(--shadow-subtle),var(--inset-shine)] outline-none transition-transform hover:scale-[0.96] motion-reduce:transition-none"
    >
      <Zap className="size-4" aria-hidden />
    </button>
  )
}

function BoardSubtitle({
  isHome,
  deptPrefix,
  isAttention,
  attentionCount,
  openCount,
  blockedTotal,
}: BoardCounts & { isHome: boolean; deptPrefix: string | undefined }) {
  return (
    <>
      {isHome && <p>The Todos you created or pinned.</p>}
      <div className="flex items-center gap-2">
        {deptPrefix && (
          <>
            <span className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}>
              {deptPrefix}
            </span>
            <Dot />
          </>
        )}
        {isAttention ? (
          <span>{attentionCount} waiting</span>
        ) : (
          <>
            <span>{openCount} open</span>
            {blockedTotal > 0 && (
              <>
                <Dot />
                <span>{blockedTotal} blocked</span>
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}

export function BoardHeader({ board, title, departments, deptPrefix, onQuickCapture, ...counts }: BoardHeaderProps) {
  return (
    <LargeTitleHeader
      title={<BoardSwitcher board={board} title={title} departments={departments} attentionCount={counts.attentionCount} />}
      subtitle={<BoardSubtitle isHome={board.kind === "home"} deptPrefix={deptPrefix} {...counts} />}
      trailing={<QuickCaptureButton onClick={onQuickCapture} />}
    />
  )
}
