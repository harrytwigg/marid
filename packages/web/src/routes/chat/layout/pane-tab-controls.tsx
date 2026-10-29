import type { ReactNode, RefObject, WheelEvent } from 'react'
import { Pin, X } from '@/components/ui/icon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { SESSION_MENU_CONTENT_CLASS, SESSION_MENU_ITEM_CLASS } from '@/components/chat/session-row-menu'
import type { PaneTabActions } from '@/components/chat/pane-tabs-context'
import type { PaneTabItem } from './pane-tab-strip'

/** The pieces of a tab's pinning that a strip's tab and a lone pane's title bar share: the buttons that pin
 * and unpin it, and the menu that offers them (right-click, or Shift+F10 / the Menu key on the focused tab). */

const GLYPH_CLASS = 'grid size-4 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] transition-opacity duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]'

/** The pin button of an unpinned tab: out of sight until the tab is hovered or its controls focused. */
export function TabPinButton({ title, active, onPin }: { title: string; active: boolean; onPin: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-pane-focus-preserving
      data-pane-tab-pin
      aria-label={`Pin tab ${title}`}
      onClick={(event) => { event.stopPropagation(); onPin() }}
      onMouseDown={(event) => event.stopPropagation()}
      className={`${GLYPH_CLASS} focus-visible:opacity-100 ${active ? 'opacity-100' : 'opacity-0 group-hover/pane-tab:opacity-100'}`}
    >
      <Pin size={11} aria-hidden />
    </button>
  )
}

/** A pinned tab's pin glyph, which stands where its close button would and unpins it. */
export function TabUnpinButton({ title, onUnpin, className = '' }: { title: string; onUnpin: () => void; className?: string }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-pane-focus-preserving
      data-pane-tab-unpin
      aria-label={`Unpin tab ${title}`}
      onClick={(event) => { event.stopPropagation(); onUnpin() }}
      onMouseDown={(event) => event.stopPropagation()}
      className={`${GLYPH_CLASS} ${className}`}
    >
      <Pin size={11} aria-hidden className="fill-current" />
    </button>
  )
}

/** The close button of a lone pane's title bar, or its unpin glyph when the tab is pinned (which a user cannot close). */
export function PaneTitleTabButton({ title, actions, onClose }: { title: string; actions: PaneTabActions | null; onClose: () => void }) {
  if (actions?.pinned) return <TabUnpinButton title={title} onUnpin={actions.unpin} className="size-[26px]" />
  return (
    <button
      type="button"
      data-pane-focus-preserving
      aria-label={`Close ${title}`}
      onClick={(event) => { event.stopPropagation(); onClose() }}
      className="grid size-[26px] shrink-0 place-items-center rounded-[var(--radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] opacity-0 transition-[color,opacity] duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover/doc-pane:opacity-100"
    >
      <X size={14} aria-hidden />
    </button>
  )
}

/** A tab's context menu around the one element that opens it: Pin tab / Unpin tab, and Close tab unless the tab cannot be closed. */
export function PaneTabMenu({ actions, children }: { actions: PaneTabActions | null; children: ReactNode }) {
  if (!actions) return <>{children}</>
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className={SESSION_MENU_CONTENT_CLASS} aria-label="Tab menu">
        <ContextMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={actions.pinned ? actions.unpin : actions.pin}>
          <Pin aria-hidden />
          {actions.pinned ? 'Unpin tab' : 'Pin tab'}
        </ContextMenuItem>
        {actions.canClose ? (
          <ContextMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={actions.close}>
            <X aria-hidden />
            Close tab
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function TabCloseButton({ title, active, onClose }: { title: string; active: boolean; onClose: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-pane-focus-preserving
      aria-label={`Close tab ${title}`}
      onClick={(event) => { event.stopPropagation(); onClose() }}
      onMouseDown={(event) => event.stopPropagation()}
      className={`grid size-4 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] transition-opacity duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] ${active ? 'opacity-100' : 'opacity-0 group-hover/pane-tab:opacity-100'}`}
    >
      <X size={12} aria-hidden />
    </button>
  )
}

/** What the tab's context menu acts on; none when the strip was given no way to pin. */
export function menuActions(tab: PaneTabItem, { onPin, onUnpin, onClose }: { onPin?: () => void; onUnpin?: () => void; onClose: () => void }): PaneTabActions | null {
  if (!onPin || !onUnpin) return null
  return { pinned: tab.pinned === true, canClose: tab.closable !== false, pin: onPin, unpin: onUnpin, close: onClose }
}

export function tabTooltip(tab: PaneTabItem): string {
  return tab.filePath ?? tab.tooltip ?? tab.title
}

/** A tab's buttons, after its label: the pin glyph of a pinned one (which unpins it) or the pin button of an
 * unpinned one, and the close button of a tab that can be closed. */
export function TabControls({ tab, active, onClose, onPin, onUnpin }: { tab: PaneTabItem; active: boolean; onClose: () => void; onPin?: () => void; onUnpin?: () => void }) {
  return (
    <>
      {tab.pinned && onUnpin ? <TabUnpinButton title={tab.title} onUnpin={onUnpin} /> : null}
      {!tab.pinned && onPin ? <TabPinButton title={tab.title} active={active} onPin={onPin} /> : null}
      {tab.closable === false ? null : <TabCloseButton title={tab.title} active={active} onClose={onClose} />}
    </>
  )
}

const TAB_CLASS = 'group/pane-tab relative flex h-full shrink-0 cursor-default select-none items-center gap-1.5 px-2.5 text-[length:var(--text-footnote)] transition-colors duration-[var(--duration-fast)] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-[var(--accent)] data-[drop-before]:shadow-[inset_2px_0_0_var(--accent)] data-[drop-after]:shadow-[inset_-2px_0_0_var(--accent)]'

/** A pinned tab is compact (icon and label, no minimum width); the rest keep a readable width. */
export function tabClassName(tab: PaneTabItem, active: boolean, dividerAfter: boolean): string {
  const width = tab.pinned ? 'max-w-[120px] min-w-0' : 'max-w-[200px] min-w-[96px]'
  const look = active ? 'bg-[var(--fill-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]'
  return `${TAB_CLASS} ${width} ${dividerAfter ? 'border-r border-[var(--separator)]' : ''} ${look}`
}

/** The divider follows a pinned tab when an unpinned one comes after it. */
export function endsPinnedRun(tabs: readonly PaneTabItem[], index: number): boolean {
  return tabs[index].pinned === true && index < tabs.length - 1 && tabs[index + 1].pinned !== true
}

/** Vertical wheel scrolls the strip sideways, as editor tab strips do. */
export function sidewaysWheel(listRef: RefObject<HTMLElement | null>) {
  return (event: WheelEvent) => {
    if (listRef.current && Math.abs(event.deltaX) < Math.abs(event.deltaY)) listRef.current.scrollLeft += event.deltaY
  }
}
