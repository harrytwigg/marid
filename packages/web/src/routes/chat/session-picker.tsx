import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Pin, Search } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import { useSessionPicker, type SessionPickerRow } from './use-session-picker'

interface SessionPickerProps {
  onPick: (sessionId: string) => void
}

function PickerSessionRow({ row, optionId, active, onActivate, onPick }: {
  row: Extract<SessionPickerRow, { kind: 'session' }>
  optionId: string
  active: boolean
  onActivate: () => void
  onPick: () => void
}) {
  const title = row.session.title?.trim() || 'Untitled chat'
  return (
    <button
      id={optionId}
      type="button"
      role="option"
      aria-selected={active}
      data-testid="session-picker-row"
      data-session-picker-row={row.id}
      onMouseMove={onActivate}
      onFocus={onActivate}
      onClick={onPick}
      className={cn(
        'group flex h-11 w-full items-center gap-[var(--space-2)] rounded-[var(--radius-md)] px-[var(--space-3)] text-left transition-[background-color,color] duration-[var(--duration-fast)]',
        active ? 'bg-[var(--fill-secondary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-primary)]',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-subheadline)] font-[var(--weight-medium)]">{title}</span>
        <span className="block truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{row.session.employee || 'Direct chat'}</span>
      </span>
      {row.pinned ? <Pin aria-label="Pinned" className="size-3.5 shrink-0 text-[var(--accent)]" /> : null}
    </button>
  )
}

function PickerRow({ row, optionId, activeId, onActivate, onPick }: {
  row: SessionPickerRow
  optionId: string | undefined
  activeId: string | undefined
  onActivate: (id: string) => void
  onPick: (id: string) => void
}) {
  if (row.kind === 'group') {
    return (
      <div data-session-picker-group={row.id} className="flex h-8 items-end px-[var(--space-3)] pb-[var(--space-1)] text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        {row.label}
      </div>
    )
  }
  return <PickerSessionRow row={row} optionId={optionId!} active={activeId === row.id} onActivate={() => onActivate(row.id)} onPick={() => onPick(row.id)} />
}

function usePickerController(onPick: (sessionId: string) => void) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { rows, loading } = useSessionPicker(query)
  const selectable = useMemo(() => rows.filter((row): row is Extract<SessionPickerRow, { kind: 'session' }> => row.kind === 'session'), [rows])
  const activeId = selectable[activeIndex]?.id
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.id ?? index,
    estimateSize: (index) => rows[index]?.kind === 'group' ? 32 : 44,
    overscan: 5,
    initialRect: { width: 400, height: 360 },
  })

  useEffect(() => setActiveIndex(0), [query, selectable.length])

  const activate = (id: string) => {
    const index = selectable.findIndex((row) => row.id === id)
    if (index >= 0) setActiveIndex(index)
  }
  const moveActive = (direction: 1 | -1) => {
    if (selectable.length === 0) return
    const nextIndex = Math.max(0, Math.min(selectable.length - 1, activeIndex + direction))
    const nextId = selectable[nextIndex]?.id
    const rowIndex = rows.findIndex((row) => row.kind === 'session' && row.id === nextId)
    setActiveIndex(nextIndex)
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
  }
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' && activeId) {
      event.preventDefault()
      onPick(activeId)
    }
  }

  return { query, setQuery, rows, loading, activeId, activate, onSearchKeyDown, scrollRef, virtualizer }
}

export function SessionPicker({ onPick }: SessionPickerProps) {
  const listboxId = useId()
  const picker = usePickerController(onPick)
  const { query, rows, loading, activeId, activate, onSearchKeyDown, scrollRef, virtualizer } = picker
  const activeOptionId = activeId ? `${listboxId}-option-${activeId}` : undefined
  const emptyLabel = query.trim() ? 'No chats match' : 'No chats yet'
  return (
    <section className="flex h-full min-h-0 w-full flex-1 flex-col bg-[var(--bg)]" aria-label="Choose a chat">
      <div data-testid="session-picker-search" className="shrink-0 px-[var(--space-3)] pb-[var(--space-2)] pt-[calc(var(--safe-top)+var(--space-12)+var(--space-2))] lg:pt-[calc(var(--space-12)+var(--space-10))]">
        <label className="flex h-9 items-center gap-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-[var(--space-3)] text-[var(--text-tertiary)] focus-within:bg-[var(--fill-secondary)] focus-within:text-[var(--text-secondary)]">
          <Search aria-hidden className="size-4 shrink-0" />
          <input
            type="search"
            role="combobox"
            aria-label="Search chats"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={rows.length > 0}
            aria-activedescendant={activeOptionId}
            placeholder="Search chats"
            value={query}
            onChange={(event) => picker.setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            className="min-w-0 flex-1 bg-transparent text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
        </label>
      </div>
      {loading ? (
        <div className="grid flex-1 place-items-center text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">Loading chats…</div>
      ) : rows.length === 0 ? (
        <div className="grid flex-1 place-items-center px-[var(--space-4)] text-center text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">{emptyLabel}</div>
      ) : (
        <div id={listboxId} ref={scrollRef} data-testid="session-picker-scroll" role="listbox" aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto px-[var(--space-2)] pb-[var(--space-3)] [scrollbar-gutter:stable]">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (!row) return null
              return (
                <div key={item.key} data-index={item.index} className="absolute left-0 top-0 w-full" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
                  <PickerRow row={row} optionId={row.kind === 'session' ? `${listboxId}-option-${row.id}` : undefined} activeId={activeId} onActivate={activate} onPick={onPick} />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
