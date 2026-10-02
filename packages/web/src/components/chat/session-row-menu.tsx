import type { ReactNode } from "react"
import { Archive, ArchiveRestore, Check, Copy, Pencil, Pin, PinOff, Square, Trash2 } from "lucide-react"
import { copyText } from "@/platform"
import { cn } from "@/lib/utils"
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

export const SESSION_MENU_CONTENT_CLASS =
  "min-w-[210px] rounded-[var(--radius-lg)] border-0 bg-[var(--material-thick)] p-1.5 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
export const SESSION_MENU_ITEM_CLASS =
  "flex min-h-9 cursor-pointer items-center gap-2 rounded-[9px] px-2.5 text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] focus:bg-[var(--fill-secondary)] focus:text-[var(--text-primary)] [&_svg]:size-[13px] [&_svg]:text-[var(--text-tertiary)]"
export const SESSION_MENU_SEPARATOR_CLASS = "mx-2 my-1 bg-[var(--separator)]"

export interface SessionMenuSession {
  id: string
  status?: string
}

export function sessionMenuCapabilities(session: SessionMenuSession): {
  canStop: boolean
} {
  return {
    canStop: session.status === "running",
  }
}

/** The visual half of a multi-select row. The row's own clickable surface owns
 *  the checkbox semantics (role/aria-checked); this is decoration, so it stays
 *  out of the accessibility tree rather than announcing a second control. */
export function SessionSelectCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      data-session-select-checkbox={checked ? "checked" : "unchecked"}
      className={cn(
        "flex size-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors",
        checked
          ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]"
          : "border-[var(--text-quaternary)] bg-transparent"
      )}
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  )
}

function CopySessionIdItem({ variant, sessionId, onCopyId }: {
  variant: "dropdown" | "context"
  sessionId: string
  onCopyId?: () => void
}) {
  const copy = () => {
    if (onCopyId) return onCopyId()
    void copyText(sessionId)
  }
  const content = <><Copy aria-hidden />Copy Session ID</>
  if (variant === "dropdown") return <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={copy}>{content}</DropdownMenuItem>
  return <ContextMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={copy}>{content}</ContextMenuItem>
}

export function SessionRowMenu({
  variant,
  session,
  isPinned,
  isArchived,
  onRename,
  onTogglePin,
  onDuplicate,
  onArchive,
  onStop,
  onCopyId,
  beforeDelete,
  onDelete,
}: {
  variant: "dropdown" | "context"
  session: SessionMenuSession
  isPinned: boolean
  isArchived: boolean
  onRename: () => void
  onTogglePin: () => void
  onDuplicate: () => void
  onArchive: () => void
  onStop: () => void
  onCopyId?: () => void
  beforeDelete?: ReactNode
  onDelete: () => void
}) {
  const capabilities = sessionMenuCapabilities(session)
  const Item = variant === "dropdown" ? DropdownMenuItem : ContextMenuItem
  const Separator = variant === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator

  return (
    <>
      <Item className={SESSION_MENU_ITEM_CLASS} onClick={onRename}>
        <Pencil aria-hidden />
        Rename
      </Item>
      <Item className={SESSION_MENU_ITEM_CLASS} onClick={onTogglePin}>
        {isPinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
        {isPinned ? "Unpin" : "Pin"}
      </Item>
      <Item className={SESSION_MENU_ITEM_CLASS} onClick={onDuplicate}>
        <Copy aria-hidden />
        Duplicate…
      </Item>
      <Item className={SESSION_MENU_ITEM_CLASS} onClick={onArchive}>
        {isArchived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
        {isArchived ? "Unarchive chat" : "Archive chat"}
      </Item>
      <Separator className={SESSION_MENU_SEPARATOR_CLASS} />
      {capabilities.canStop ? (
        <Item className={SESSION_MENU_ITEM_CLASS} onClick={onStop}>
          <Square aria-hidden />
          Stop session
        </Item>
      ) : null}
      <CopySessionIdItem variant={variant} sessionId={session.id} onCopyId={onCopyId} />
      {beforeDelete}
      <Separator className={SESSION_MENU_SEPARATOR_CLASS} />
      <Item
        variant="destructive"
        className={`${SESSION_MENU_ITEM_CLASS} text-[var(--system-red)] focus:text-[var(--system-red)] [&_svg]:text-[var(--system-red)]`}
        onClick={onDelete}
      >
        <Trash2 aria-hidden />
        <span className="flex-1">Delete session</span>
        {variant === "context" ? (
          <kbd className="ml-auto pl-3 font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
        ) : null}
      </Item>
    </>
  )
}
