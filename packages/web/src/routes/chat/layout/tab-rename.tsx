import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

/** The title a rename should save: the draft trimmed, or null when it is empty or no change (both cancel). */
export function renamedTitle(current: string, draft: string): string | null {
  const next = draft.trim()
  return next && next !== current ? next : null
}

interface TabRenameInputProps {
  /** The title being edited, which the field starts with, selected. */
  value: string
  /** Enter or leaving the field with a new title in it. */
  onCommit: (title: string) => void
  /** Escape, or Enter or leaving the field with nothing new in it. */
  onCancel: () => void
  className?: string
}

/**
 * An inline title editor for a tab or a lone pane's title bar. Enter confirms, Escape cancels, and so
 * does an empty or unchanged title. Its keys and presses stop here: a tab's own handlers would read
 * the arrows, Delete and Backspace as moving or closing the tab, and a press would start its drag.
 */
export function TabRenameInput({ value, onCommit, onCancel, className = '' }: TabRenameInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  // Enter and Escape end the edit, and the blur that follows must not end it a second time.
  const done = useRef(false)
  useEffect(() => { ref.current?.select() }, [])
  const finish = (draft: string | null) => {
    if (done.current) return
    done.current = true
    const next = draft === null ? null : renamedTitle(value, draft)
    if (next) onCommit(next)
    else onCancel()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') { event.preventDefault(); finish(event.currentTarget.value) }
    else if (event.key === 'Escape') { event.preventDefault(); finish(null) }
  }
  return (
    <input
      ref={ref}
      autoFocus
      data-pane-focus-preserving
      data-pane-tab-rename
      aria-label="Rename tab"
      defaultValue={value}
      maxLength={200}
      onKeyDown={onKeyDown}
      onBlur={(event) => finish(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      className={`min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--bg)] px-1 text-inherit outline-none ${className}`}
    />
  )
}

/**
 * The edit state of one renameable title: `start` (absent when there is nothing to rename with, so a
 * menu or key offering it can tell), whether it is `renaming`, and the props its `input` takes while it is.
 * `onEnd` runs when the edit ends either way, to hand focus back.
 */
export function useInlineRename(save: ((title: string) => void | Promise<void>) | undefined, onEnd?: () => void) {
  const [renaming, setRenaming] = useState(false)
  const end = () => { setRenaming(false); onEnd?.() }
  return {
    renaming,
    start: save ? () => setRenaming(true) : undefined,
    input: renaming && save ? { onCommit: (title: string) => { end(); void save(title) }, onCancel: end } : undefined,
  }
}
