import { Zap } from "lucide-react"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import type { DepartmentSummaryWire } from "@/lib/api"
import type { BoardId } from "./board-route"
import { ArchivedTag, BoardSwitcher } from "./board-switcher"
import { DepartmentArchiveMenu } from "./department-archive-menu"

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

/** The department board's department, when there is one. */
function boardDepartment(board: BoardId, departments: DepartmentSummaryWire[] | undefined): DepartmentSummaryWire | undefined {
  return board.kind === "department" ? departments?.find((dept) => dept.slug === board.slug) : undefined
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
  deptPrefix,
  archived,
  isAttention,
  attentionCount,
  openCount,
  blockedTotal,
}: BoardCounts & { deptPrefix: string | undefined; archived: boolean }) {
  return (
    <>
      <div className="flex items-center gap-2">
        {archived && <ArchivedTag />}
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
  const department = boardDepartment(board, departments)
  return (
    <LargeTitleHeader
      title={<BoardSwitcher board={board} title={title} departments={departments} attentionCount={counts.attentionCount} />}
      subtitle={<BoardSubtitle deptPrefix={deptPrefix} archived={department?.archived === true} {...counts} />}
      trailing={
        <div className="flex items-center gap-2">
          {department && <DepartmentArchiveMenu slug={department.slug} prefix={department.prefix} archived={department.archived === true} />}
          <QuickCaptureButton onClick={onQuickCapture} />
        </div>
      }
    />
  )
}
