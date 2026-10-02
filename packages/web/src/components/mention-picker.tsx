import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject, type SyntheticEvent } from "react"
import type { Employee } from "@/lib/api"
import { activeMention, filterMentionCandidates, insertMention, mentionRoster } from "@/lib/mentions"

/* The @mention picker for a comment composer. It watches the text and the caret;
 * while the caret sits at the end of an `@prefix` it offers the employees whose
 * name or display name starts with it. The composer keeps its own submit rules —
 * it asks `onKeyDown` first, and only an event the picker did not take reaches
 * them, which is what keeps Enter from sending while the list is open. */

export interface MentionPicker {
  open: boolean
  /** True when the picker took the key (the caller must not act on it). */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** The textarea's change handler: writes the text and follows the caret. */
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  /** The textarea's select handler: the caret moved without the text changing. */
  onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void
  list: React.ReactNode
}

/** What each key does while the list is open: a step through it, or a verb. */
const KEY_ACTION: Record<string, 1 | -1 | "choose" | "dismiss"> = {
  ArrowDown: 1,
  ArrowUp: -1,
  Enter: "choose",
  Tab: "choose",
  Escape: "dismiss",
}

/** Put the caret where an insertion left it, once React has written the text. */
function useCaretAfterInsert(value: string, textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const pending = useRef<number | null>(null)
  useEffect(() => {
    const at = pending.current
    const textarea = textareaRef.current
    if (at === null || !textarea) return
    pending.current = null
    textarea.focus()
    textarea.setSelectionRange(at, at)
  }, [value, textareaRef])
  return (at: number) => {
    pending.current = at
  }
}

/** The `@prefix` at the caret and who it offers; Escape dismisses that one
 *  token until the caret leaves it. */
function useMentionCandidates(value: string, caret: number, employees: Employee[]) {
  const roster = useMemo(() => mentionRoster(employees), [employees])
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const active = activeMention(value, caret)
  const typing = active !== null
  useEffect(() => {
    if (!typing) setDismissedAt(null)
  }, [typing])
  const candidates = active && active.start !== dismissedAt ? filterMentionCandidates(roster, active.query) : []
  return { active, candidates, dismiss: () => setDismissedAt(active?.start ?? null) }
}

export function useMentionPicker({
  value,
  setValue,
  employees,
  textareaRef,
}: {
  value: string
  setValue: (value: string) => void
  employees: Employee[]
  textareaRef: RefObject<HTMLTextAreaElement | null>
}): MentionPicker {
  const listId = useId()
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState(0)
  const placeCaret = useCaretAfterInsert(value, textareaRef)
  const { active, candidates, dismiss } = useMentionCandidates(value, caret, employees)
  const open = candidates.length > 0
  const index = Math.min(selected, Math.max(candidates.length - 1, 0))

  const choose = (employee: Employee) => {
    if (!active) return
    const next = insertMention(value, active.start, caret, employee.name)
    placeCaret(next.caret)
    setValue(next.value)
    setCaret(next.caret)
  }

  return {
    open,
    onChange: (event) => {
      setValue(event.target.value)
      setCaret(event.target.selectionStart)
      setSelected(0)
    },
    onSelect: (event) => setCaret(event.currentTarget.selectionStart),
    onKeyDown: (event) => {
      const action = open ? KEY_ACTION[event.key] : undefined
      if (!action) return false
      if (action === "choose") choose(candidates[index])
      else if (action === "dismiss") {
        event.stopPropagation()
        dismiss()
      } else setSelected((index + action + candidates.length) % candidates.length)
      event.preventDefault()
      return true
    },
    list: open && <MentionList id={listId} candidates={candidates} selected={index} onChoose={choose} />,
  }
}

function MentionList({
  id,
  candidates,
  selected,
  onChoose,
}: {
  id: string
  candidates: Employee[]
  selected: number
  onChoose: (employee: Employee) => void
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Mention an employee"
      data-testid="mention-picker"
      className="absolute inset-x-0 bottom-full z-30 mb-1 max-h-[240px] overflow-y-auto rounded-[14px] bg-[var(--bg-secondary)] p-1 shadow-[var(--shadow-card)]"
    >
      {candidates.map((employee, i) => (
        <li
          key={employee.name}
          id={`${id}-${employee.name}`}
          role="option"
          aria-selected={i === selected}
          data-testid={`mention-option-${employee.name}`}
          // mousedown, not click: the textarea must keep focus and its caret.
          onMouseDown={(event) => {
            event.preventDefault()
            onChoose(employee)
          }}
          className={`flex cursor-pointer items-baseline gap-2 rounded-[10px] px-2.5 py-1.5 text-[13.5px] max-[700px]:min-h-[34px] ${
            i === selected ? "bg-[var(--fill-secondary)]" : ""
          }`}
        >
          <span className="font-medium text-[var(--text-primary)]">{employee.displayName}</span>
          <span className="text-[12px] text-[var(--text-tertiary)]">@{employee.name}</span>
        </li>
      ))}
    </ul>
  )
}
