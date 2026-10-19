import { Archive, ArchiveRestore, EllipsisVertical, Pin, PinOff, Trash2 } from "@/components/ui/icon"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { SESSION_MENU_CONTENT_CLASS, SessionRowMenu } from "@/components/chat/session-row-menu"
import { type Session } from "@/components/chat/session-signals"
import { type SwipeSide } from "@/components/chat/use-swipe-actions"

/** Width of one revealed action. Paired with the row's 64px floor this is the
 *  44pt touch target the phone layout owes every action. */
export const ACTION_WIDTH = 78

const ACTION_CLASS =
  "flex h-full w-[78px] shrink-0 flex-col items-center justify-center gap-1 text-caption2 font-[var(--weight-medium)] [&_svg]:size-[18px]"

export interface RowActions {
  onRename: () => void
  onTogglePin: () => void
  onDuplicate: () => void
  onArchive: () => void
  onStop: () => void
  onDelete: () => void
}

/** The rail a swipe has uncovered. Only the exposed side is mounted: the other
 *  one sits under a selected row's translucent fill and shows straight through
 *  it, and a hidden Delete beneath a closed row is a mis-tap waiting to happen.
 *  Screen readers reach the same actions through the `⋯` menu. */
export function SwipeActionRails({
  side,
  isPinned,
  isArchived,
  onTogglePin,
  onArchive,
  onDelete,
}: Pick<RowActions, "onTogglePin" | "onArchive" | "onDelete"> & {
  side: SwipeSide
  isPinned: boolean
  isArchived: boolean
}) {
  if (side === "leading") {
    return (
      <div data-testid="swipe-rail-leading" className="absolute inset-y-0 left-0 flex">
        <button
          onClick={onTogglePin}
          className={cn(ACTION_CLASS, "bg-[color-mix(in_srgb,var(--system-orange)_18%,transparent)] text-[var(--system-orange)]")}
        >
          {isPinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
          {isPinned ? "Unpin" : "Pin"}
        </button>
      </div>
    )
  }
  return (
    <div data-testid="swipe-rail-trailing" className="absolute inset-y-0 right-0 flex">
      <button
        onClick={onArchive}
        className={cn(ACTION_CLASS, "bg-[var(--fill-secondary)] text-[var(--text-secondary)]")}
      >
        {isArchived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
        {isArchived ? "Unarchive" : "Archive"}
      </button>
      <button
        onClick={onDelete}
        className={cn(ACTION_CLASS, "bg-[color-mix(in_srgb,var(--system-red)_18%,transparent)] text-[var(--system-red)]")}
      >
        <Trash2 aria-hidden />
        Delete
      </button>
    </div>
  )
}

/** The non-swipe path to every action, visible at rest rather than on hover. */
export function MobileRowMenu({
  session,
  isPinned,
  isArchived,
  ...actions
}: RowActions & { session: Session; isPinned: boolean; isArchived: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Chat actions"
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)]"
        >
          <EllipsisVertical className="size-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
        <SessionRowMenu variant="dropdown" session={session} isPinned={isPinned} isArchived={isArchived} {...actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
