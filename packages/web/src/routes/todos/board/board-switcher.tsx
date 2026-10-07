import { Archive, Bell, ChevronDown, Globe } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DepartmentScopeBadge } from "@/components/department-scope-badge"
import type { DepartmentRowWire } from "@/lib/department-api"
import { boardPath, isSameBoard, type BoardId } from "./board-route"
import { useBoardMenuCounts } from "./use-board"

/* Todos v2 slice 6 — the switcher-in-title (design-doc §1.1, HIG title-menu).
 * The page title IS the menu trigger: current board name + chevron.
 *
 * The rows split into lenses and places. The two lenses lead —
 * Attention (the ONLY badge anywhere, §8's one ambient signal) · Everything —
 * and the departments follow under their own group label. Order is the whole
 * point: Everything used to sit last, so at fourteen departments the operator
 * had to scroll the menu to reach it. Open counts load lazily
 * when the menu opens.
 *
 * Archived departments take no new Todos, so they stay out of the list until
 * "Show archived" asks for them; their boards and Todos are unchanged. */

const MENU_CLASS =
  "w-[min(300px,calc(100vw-24px))] rounded-[var(--radius-xl)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
const ROW_CLASS =
  "min-h-10 cursor-pointer gap-2.5 rounded-[9px] px-2.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)] focus:bg-[var(--fill-tertiary)]"

export interface BoardSwitcherProps {
  board: BoardId
  title: string
  departments: DepartmentRowWire[] | undefined
  attentionCount: number
}

export function BoardSwitcher({ board, title, departments, attentionCount }: BoardSwitcherProps) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const counts = useBoardMenuCounts(departments, open)
  const archivedCount = departments?.filter((dept) => dept.archived).length ?? 0
  // On an archived department's own board the list shows where you are.
  const onArchived = board.kind === "department" && departments?.some((dept) => dept.slug === board.slug && dept.archived)
  const listed = departments?.filter((dept) => !dept.archived || showArchived || onArchived) ?? []

  const go = (target: BoardId) => {
    if (!isSameBoard(board, target)) navigate(boardPath(target))
  }
  const countOf = (value: number | undefined) => (
    <span className="ml-auto text-[12px] tabular-nums text-[var(--text-quaternary)]">{value ?? ""}</span>
  )

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="board-switcher"
          aria-label={`Board: ${title} — switch board`}
          className="focus-ring -ml-0.5 flex items-center gap-2 rounded-xl py-0.5 pl-0.5 pr-2.5 transition-colors duration-150 hover:bg-[var(--fill-quaternary)]"
        >
          <h1>
            {title}
          </h1>
          <ChevronDown size={18} strokeWidth={2.2} aria-hidden className="mt-1.5 text-[var(--text-quaternary)]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={MENU_CLASS}>
        <DropdownMenuItem className={ROW_CLASS} data-testid="board-menu-attention" onClick={() => go({ kind: "attention" })}>
          <LensIcon of={Bell} />
          Attention
          {attentionCount > 0 && (
            <span className="ml-auto rounded-full bg-[var(--accent-fill)] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[var(--accent)]">
              {attentionCount}
            </span>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem className={ROW_CLASS} data-testid="board-menu-everything" onClick={() => go({ kind: "everything" })}>
          <LensIcon of={Globe} />
          Everything
          {countOf(counts.data?.everything)}
        </DropdownMenuItem>
        {(departments?.length ?? 0) > 0 && (
          <>
            <DropdownMenuLabel className="px-2.5 pb-1 pt-2.5 text-[length:var(--text-caption1)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
              Departments
            </DropdownMenuLabel>
            {listed.map((dept) => (
              <DropdownMenuItem
                key={dept.slug}
                className={ROW_CLASS}
                data-testid={`board-menu-${dept.slug}`}
                onClick={() => go({ kind: "department", slug: dept.slug })}
              >
                <span
                  className="w-9 flex-none text-[11px] text-[var(--text-quaternary)]"
                  style={{ fontFamily: "var(--font-code)", letterSpacing: ".04em" }}
                >
                  {dept.prefix}
                </span>
                <span className={`truncate ${dept.archived ? "text-[var(--text-tertiary)]" : ""}`}>{departmentTitle(dept.slug)}</span>
                {dept.archived ? <ArchivedTag /> : <DepartmentScopeBadge scope={dept.scope} />}
                {countOf(counts.data?.byDepartment[dept.slug])}
              </DropdownMenuItem>
            ))}
            {archivedCount > 0 && !onArchived && (
              <DropdownMenuItem
                className={`${ROW_CLASS} text-[var(--text-secondary)]`}
                data-testid="board-menu-show-archived"
                // Keep the menu open: the rows it reveals are what the operator came for.
                onSelect={(event) => {
                  event.preventDefault()
                  setShowArchived((shown) => !shown)
                }}
              >
                <LensIcon of={Archive} />
                {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Marks an archived department wherever one is listed. */
export function ArchivedTag() {
  return (
    <span
      data-testid="department-archived-tag"
      className="flex-none rounded-full bg-[var(--fill-tertiary)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]"
    >
      Archived
    </span>
  )
}

/** The lens rows' leading glyph. Departments use their mono prefix instead —
 *  a place has a name in the ID scheme, a lens does not. */
function LensIcon({ of: Icon }: { of: typeof Bell }) {
  return <Icon size={15} strokeWidth={2} aria-hidden className="flex-none text-[var(--text-tertiary)]" />
}

export function departmentTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}
