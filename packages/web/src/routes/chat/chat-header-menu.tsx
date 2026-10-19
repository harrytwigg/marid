import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Copy, ExternalLink, MoreHorizontal, PanelRightOpen, Pin, PinOff, Search, Share2, Trash2 } from '@/components/ui/icon'
import { sessionUrl } from '@/components/chat/chat-route-helpers'
import { ViewModeItems } from '@/components/chat/view-mode-items'
import { SESSION_MENU_CONTENT_CLASS, SESSION_MENU_ITEM_CLASS, SESSION_MENU_SEPARATOR_CLASS } from '@/components/chat/session-row-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { usePins, useTogglePin } from '@/hooks/use-pins'
import { openExternal } from '@/platform'
import type { ViewMode } from '@/lib/view-mode'

const EMPTY_PINS = new Set<string>()

/** Holds an icon's place in an item that has none, so the labels of a group line up. */
function NoIcon() {
  return <span aria-hidden className="size-[13px] shrink-0" />
}

/** The copy of the trigger the person pressed to open the menu, until it closes. */
let pressedCopy: HTMLElement | null = null

/** Whether a copy of the trigger is on screen: not `display: none`, itself or by an ancestor. */
function isDisplayed(node: HTMLElement | null): boolean {
  for (let el = node; el; el = el.parentElement) if (getComputedStyle(el).display === 'none') return false
  return node !== null
}

/** The copy the popup belongs to: the one pressed, else (opened by the prop alone, with no press) the first that is displayed. */
function isPlacedCopy(element: HTMLElement | null): boolean {
  if (pressedCopy) return pressedCopy === element
  return Array.from(document.querySelectorAll<HTMLElement>('[data-more-menu]')).find(isDisplayed) === element
}

interface ChatHeaderMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedId: string | null
  sessionMeta: { engine?: string; engineSessionId?: string; archivedAt?: string | null } | null
  openGlobalSearch: () => void
  effectiveViewMode: ViewMode
  cliModeAvailable: boolean
  viewSwitchLocked: boolean
  cliTitle: string | undefined
  setAndPersistViewMode: (mode: ViewMode) => void
  onDuplicate: (id: string) => void
  duplicatePending: boolean
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onCopyToClipboard: (text: string, field: string) => void
  onShareDebugLog: () => void
  onClearDebugLog: () => void
  onDeleteSession: (id: string) => void
  onOpenChatBeside: () => void
}

/** The items below the view toggle, where a session is guaranteed to exist. */
type SelectedChatProps = Omit<ChatHeaderMenuProps, 'selectedId'> & { selectedId: string }

function usePlacedPopup(open: boolean, onOpenChange: (open: boolean) => void) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  // The route's `open` reaches both copies, but one popup is placed, against the displayed trigger.
  const [shown, setShown] = useState(false)
  useLayoutEffect(() => {
    if (!open) pressedCopy = null
    setShown(open && isPlacedCopy(triggerRef.current))
  }, [open])
  // Crossing the breakpoint hides the copy the popup hangs from: close rather than leave it adrift.
  useEffect(() => {
    if (!open || !shown) return
    const closeIfHidden = () => { if (!isDisplayed(triggerRef.current)) onOpenChange(false) }
    window.addEventListener('resize', closeIfHidden)
    return () => window.removeEventListener('resize', closeIfHidden)
  }, [open, shown, onOpenChange])
  return { triggerRef, shown }
}

// More (…) menu — rendered as the last control inside the right header pill.
// D7: ALWAYS rendered (even on a new chat, where it carries Search, the view
// toggle, and Open beside) so the right pill is consistent. When a session is
// selected the items are grouped: primary (Search · view toggle · Open beside · Open in new
// tab · Pin · Duplicate) → Developer
// cluster → destructive Delete, each separated.
//
// Open state lives in the route (it closes the menu from several places: a finished
// duplicate, a copy to the clipboard, Search), so the menu is controlled. The popup is the shared dropdown menu: it closes on an outside press,
// Escape and a choice, and puts focus back on the trigger. This node is rendered
// twice (desktop tab bar + mobile header, one hidden via CSS), and both copies
// share the one `open`, so only the displayed trigger's popup is ever placed.
export function ChatHeaderMenu(props: ChatHeaderMenuProps) {
  const { open, onOpenChange, selectedId } = props
  const { triggerRef, shown } = usePlacedPopup(open, onOpenChange)

  return (
    <DropdownMenu open={open && shown} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-more-menu
          onPointerDownCapture={() => { pressedCopy = triggerRef.current }}
          onKeyDownCapture={() => { pressedCopy = triggerRef.current }}
          aria-label="More options"
          className="inline-flex size-11 lg:size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground data-[menu-open]:bg-[var(--fill-secondary)]"
        >
          <MoreHorizontal className="size-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
        {/* PRIMARY group — Search (⌘K), the Chat/CLI view toggle, Open beside, then Open in
            new tab, Pin and Duplicate (only when a session is selected). */}
        {/* D4: Search lives at the very top — the only visible ⌘K entry point on desktop. */}
        <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={props.openGlobalSearch}>
          <Search aria-hidden />
          <span className="flex-1">Search…</span>
          <kbd className="font-mono text-caption2 text-[var(--text-quaternary)]">⌘K</kbd>
        </DropdownMenuItem>
        <ViewModeItems viewMode={props.effectiveViewMode} cliModeAvailable={props.cliModeAvailable} viewSwitchLocked={props.viewSwitchLocked} cliTitle={props.cliTitle} onChange={props.setAndPersistViewMode} />
        <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={props.onOpenChatBeside}>
          <PanelRightOpen aria-hidden />
          <span className="flex-1">Open beside</span>
        </DropdownMenuItem>
        {selectedId && <SelectedChatItems {...props} selectedId={selectedId} />}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SelectedChatItems(props: SelectedChatProps) {
  const { selectedId, sessionMeta } = props
  const archived = Boolean(sessionMeta?.archivedAt)

  return (
    <>
      <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => { void openExternal(sessionUrl(selectedId)) }}>
        <ExternalLink aria-hidden />
        <span className="flex-1">Open in new tab</span>
      </DropdownMenuItem>
      <PinItem selectedId={selectedId} />
      {/* Stays open while the copy is made ("Duplicating..."); the route closes it once the copy opens, and a failed copy leaves it open beside the alert. */}
      <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} disabled={props.duplicatePending} onSelect={(event) => event.preventDefault()} onClick={() => props.onDuplicate(selectedId)}>
        <Copy aria-hidden />
        <span className="flex-1">{props.duplicatePending ? 'Duplicating...' : 'Duplicate...'}</span>
      </DropdownMenuItem>

      <DropdownMenuSeparator className={SESSION_MENU_SEPARATOR_CLASS} />
      <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => { if (archived) props.onUnarchive(selectedId); else props.onArchive(selectedId) }}>
        {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
        <span className="flex-1">{archived ? 'Unarchive chat' : 'Archive chat'}</span>
      </DropdownMenuItem>

      <DeveloperItems {...props} />

      {/* DESTRUCTIVE */}
      <DropdownMenuSeparator className={SESSION_MENU_SEPARATOR_CLASS} />
      <DropdownMenuItem
        variant="destructive"
        className={`${SESSION_MENU_ITEM_CLASS} text-[var(--system-red)] focus:text-[var(--system-red)] [&_svg]:text-[var(--system-red)]`}
        onClick={() => { if (window.confirm('Delete this session?')) props.onDeleteSession(selectedId) }}
      >
        <Trash2 aria-hidden />
        <span className="flex-1">Delete Session</span>
        <kbd className="font-mono text-caption2 text-[var(--text-quaternary)]">⌫</kbd>
      </DropdownMenuItem>
    </>
  )
}

// The chat pin is keyed by session id, exactly as the sidebar row menu keys it.
// Not to be confused with the route's tab `pinned` flag, a different concept.
function PinItem({ selectedId }: Pick<SelectedChatProps, 'selectedId'>) {
  const { data: pinnedKeys = EMPTY_PINS } = usePins()
  const { mutate: togglePin } = useTogglePin()
  const isPinned = pinnedKeys.has(selectedId)

  return (
    <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => togglePin({ key: selectedId, pinned: !isPinned })}>
      {isPinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
      <span className="flex-1">{isPinned ? 'Unpin' : 'Pin'}</span>
    </DropdownMenuItem>
  )
}

function DeveloperItems(props: SelectedChatProps) {
  const { selectedId, sessionMeta, onCopyToClipboard } = props

  return (
    <>
      <DropdownMenuSeparator className={SESSION_MENU_SEPARATOR_CLASS} />
      <DropdownMenuLabel className="px-2.5 pb-1 pt-2 text-caption2 font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
        Developer
      </DropdownMenuLabel>
      <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => onCopyToClipboard(selectedId, 'id')}>
        <NoIcon />
        Copy Session ID
      </DropdownMenuItem>
      {sessionMeta?.engineSessionId && (
        <DropdownMenuItem
          className={SESSION_MENU_ITEM_CLASS}
          onClick={() => {
            const cli = sessionMeta.engine === 'codex' ? 'codex' : 'claude'
            onCopyToClipboard(`${cli} --resume ${sessionMeta.engineSessionId}`, 'cli')
          }}
        >
          <NoIcon />
          Copy CLI Resume Command
        </DropdownMenuItem>
      )}
      <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={props.onShareDebugLog}>
        <Share2 aria-hidden />
        <span className="flex-1">Share debug log</span>
      </DropdownMenuItem>
      <DropdownMenuItem className={`${SESSION_MENU_ITEM_CLASS} text-[var(--text-secondary)]`} onClick={props.onClearDebugLog}>
        <NoIcon />
        Clear debug log
      </DropdownMenuItem>
    </>
  )
}
