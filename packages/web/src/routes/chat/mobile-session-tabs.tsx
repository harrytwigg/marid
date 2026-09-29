import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { StatusDot } from '@/components/chat/session-signals'
import { cn } from '@/lib/utils'
import './mobile-session-tabs.css'

export interface MobileSessionTab {
  id: string
  title: string
  /** The chat received something while another one was in front. */
  moved: boolean
}

function CloseButton({ tab, onClose }: { tab: MobileSessionTab; onClose: (sessionId: string) => void }) {
  return (
    <button
      type="button"
      aria-label={`Close ${tab.title}`}
      data-mobile-session-tab-close={tab.id}
      onClick={() => onClose(tab.id)}
      className="inline-flex size-11 shrink-0 items-center justify-center text-[var(--text-secondary)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--text-primary)] active:bg-[var(--fill-secondary)]"
    >
      <X size={12} aria-hidden />
    </button>
  )
}

function TabCell({
  tab,
  active,
  cellRef,
  onSelect,
  onClose,
}: {
  tab: MobileSessionTab
  active: boolean
  cellRef?: (node: HTMLDivElement | null) => void
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
}) {
  return (
    <div
      ref={cellRef}
      role="presentation"
      data-mobile-session-tab-cell={tab.id}
      className={cn(
        'relative flex h-11 shrink-0 items-center rounded-lg transition-colors duration-[var(--duration-fast)]',
        active ? 'bg-[var(--fill-secondary)]' : 'bg-transparent',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-mobile-session-tab={tab.id}
        data-mobile-session-tab-active={active ? 'true' : 'false'}
        onClick={() => onSelect(tab.id)}
        className={cn(
          'h-11 min-w-11 max-w-[9.5rem] truncate pl-2.5 text-left text-[length:var(--text-footnote)]',
          active ? 'pr-0.5 text-[var(--text-primary)]' : 'pr-2.5 text-[var(--text-secondary)]',
        )}
      >
        {tab.title}
      </button>
      {tab.moved && !active ? (
        <StatusDot
          color="var(--text-secondary)"
          title={`${tab.title} updated`}
          data-mobile-session-tab-moved=""
          className="pointer-events-none absolute right-1.5 top-2.5 size-1.5"
        />
      ) : null}
      {active ? <CloseButton tab={tab} onClose={onClose} /> : null}
    </div>
  )
}

/**
 * Labelled, horizontally scrollable tabs for the phone's open chats. Every
 * target is 44px tall; the focused tab carries the close control and is kept in
 * view as the focus moves.
 */
export function MobileSessionTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
}: {
  tabs: MobileSessionTab[]
  activeId: string | null
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
}) {
  const activeRef = useRef<HTMLDivElement | null>(null)

  // A title arriving widens its tab, which can push the focused one back out of
  // view, so the labels are as much a trigger as the focus and the count.
  const labels = tabs.map((tab) => tab.title).join('\u0000')
  useEffect(() => {
    const node = activeRef.current
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }
  }, [activeId, tabs.length, labels])

  return (
    <nav data-mobile-session-tabs aria-label="Open chats" className="flex min-w-0 flex-1">
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId
          return (
            <TabCell
              key={tab.id}
              tab={tab}
              active={active}
              cellRef={active ? (node) => { activeRef.current = node } : undefined}
              onSelect={onSelect}
              onClose={onClose}
            />
          )
        })}
      </div>
    </nav>
  )
}
