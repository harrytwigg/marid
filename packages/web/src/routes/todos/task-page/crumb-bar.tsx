import { ChevronLeft, ChevronRight, Copy, Link as LinkIcon, MoreHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Slot } from "@/contrib/slot"
import { AREAS } from "@/contrib/types"
import { gatewayTransport } from "@/lib/gateway-transport"
import { todoPath } from "@/lib/todo-id"
import { copyText as platformCopyText } from "@/platform"
import { KeepToggle } from "../board/keep-control"

/* Todos v2 slice 6 — the task page's breadcrumb bar (design-doc §7.1, mock
 * task-detail.html). Board context › ancestor IDs › current ID + title. The
 * board name is the back affordance; copy-link and ⋯ sit at the bar's right.
 * Ancestors render as bare mono IDs; only the current segment carries the
 * title (single-line ellipsis — polish law 18). */

export interface CrumbAncestor {
  id: string
  title: string
}

function Csep() {
  return (
    <ChevronRight
      size={11}
      strokeWidth={2.2}
      aria-hidden
      className="flex-none text-[var(--text-quaternary)]"
    />
  )
}

export function CrumbBar({
  boardLabel,
  onBack,
  ancestors,
  id,
  title,
  onOpenAncestor,
  onCopyId,
  mobile,
  kept,
  onKeep,
  pageSlots = true,
}: {
  boardLabel: string
  onBack: () => void
  ancestors: CrumbAncestor[]
  id: string
  title: string
  onOpenAncestor: (id: string) => void
  onCopyId: () => void
  mobile: boolean
  /** ICI-1357: whether this Todo is on the operator's Home board. */
  kept?: boolean
  onKeep?: (vars: { id: string; kept: boolean }) => void
  /** Plugin actions are page-scoped (a contribution reads its Todo from the URL), so a Todo shown
   *  as a tab of the chat layout renders none. */
  pageSlots?: boolean
}) {
  const copyText = (text: string) => void platformCopyText(text)
  return (
    <div
      data-testid="task-crumb-bar"
      className={
        mobile
          ? "flex min-h-[52px] items-center gap-2 px-3.5 pb-2 pt-[calc(10px+var(--safe-top,0px))]"
          : "mx-auto flex min-h-[56px] w-full max-w-[1080px] items-center gap-2 px-6 pb-2 pt-3.5 @2xl:px-10"
      }
    >
      {mobile ? (
        <button
          type="button"
          aria-label="Back"
          data-testid="task-crumb-back"
          onClick={onBack}
          className="focus-ring grid size-[34px] flex-none place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
        >
          <ChevronLeft size={17} strokeWidth={2.2} aria-hidden />
        </button>
      ) : (
        <div className="-ml-2 flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap pl-2">
          {/* Text sits on the 96px spine; the wash bleeds -8px (polish law 5). */}
          <button
            type="button"
            data-testid="task-crumb-board"
            onClick={onBack}
            className="focus-ring -mx-2 -my-1 rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--text-secondary)] outline-none hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-primary)]"
          >
            {boardLabel}
          </button>
          <Csep />
          {ancestors.map((ancestor) => (
            <span key={ancestor.id} className="flex flex-none items-center gap-2">
              <button
                type="button"
                data-testid={`task-crumb-${ancestor.id}`}
                onClick={() => onOpenAncestor(ancestor.id)}
                title={ancestor.title}
                className="focus-ring -mx-1 rounded-md px-1 text-[11.5px] tracking-[.04em] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
                style={{ fontFamily: "var(--font-code)" }}
              >
                {ancestor.id}
              </button>
              <Csep />
            </span>
          ))}
          <button
            type="button"
            data-testid="task-copy-id"
            aria-label={`Copy ${id}`}
            onClick={onCopyId}
            className="focus-ring -mx-1 flex min-h-[34px] flex-none items-center rounded-md px-1 text-[11.5px] tracking-[.04em] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {id}
          </button>
          <span className="min-w-0 truncate text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
        </div>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-0.5">
        {/* Contributed actions lead the group so the app's own copy-link and ⋯
            stay where the muscle memory expects them, at the bar's edge. However
            many a plugin adds, they scroll within their own strip rather than
            pushing the app's two buttons off a 390px bar. */}
        {pageSlots && <Slot
          area={AREAS.todoDetailActions}
          variant="chip"
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
        />}
        {/* Absent while the Todo is still loading: no state to toggle yet. */}
        {kept !== undefined && onKeep && <KeepToggle id={id} kept={kept} onToggle={onKeep} className="size-[34px] rounded-[10px]" />}
        <button
          type="button"
          aria-label={`Copy link to ${id}`}
          data-testid="task-copy-link"
          onClick={() => copyText(gatewayTransport().httpUrl(todoPath(id)))}
          className="focus-ring grid size-[34px] flex-none place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
        >
          <LinkIcon size={14} strokeWidth={2} aria-hidden />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More"
              data-testid="task-crumb-more"
              className="focus-ring grid size-[34px] flex-none place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
            >
              <MoreHorizontal size={16} aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-[180px] rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
          >
            <DropdownMenuItem
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-[9px] px-2.5 text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] focus:bg-[var(--fill-secondary)]"
              onClick={onCopyId}
            >
              <Copy size={13} aria-hidden />
              Copy ID
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
