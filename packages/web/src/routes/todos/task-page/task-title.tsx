import { useState } from "react"

/** Inline title edit — borderless, Notes pattern: tap to edit, Enter commits,
 *  Esc reverts. An emptied title reverts rather than committing. */
export function TaskTitle({ title, mobile, onCommit }: {
  title: string | null
  mobile: boolean
  onCommit: (title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const sizing = mobile
    ? "text-[26px] font-bold leading-[1.2] tracking-[-0.41px]"
    : "text-[28px] font-bold leading-[1.2] tracking-[-0.41px]"
  const bleed = mobile ? "" : "-mx-2 rounded-[10px] px-2 py-0.5"

  if (editing) {
    return (
      <TitleInput
        draft={draft}
        onDraft={setDraft}
        className={`${sizing} ${bleed}`}
        onBlur={() => {
          setEditing(false)
          const next = draft.trim()
          if (next && next !== title) onCommit(next)
        }}
        onRevert={() => {
          setDraft(title ?? "")
          setEditing(false)
        }}
      />
    )
  }
  return (
    <h1 className={mobile ? "" : "min-w-0"}>
      <button
        type="button"
        data-testid="task-title"
        aria-label="Edit title"
        onClick={() => {
          if (title === null) return
          setDraft(title)
          setEditing(true)
        }}
        className={`${sizing} ${bleed} w-full cursor-text text-left text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--fill-quaternary)]`}
      >
        {title ?? "…"}
      </button>
    </h1>
  )
}

function TitleInput({ draft, onDraft, className, onBlur, onRevert }: {
  draft: string
  onDraft: (draft: string) => void
  className: string
  onBlur: () => void
  onRevert: () => void
}) {
  return (
    <input
      autoFocus
      data-testid="task-title-edit"
      value={draft}
      onChange={(e) => onDraft(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur()
        if (e.key === "Escape") {
          e.preventDefault()
          onRevert()
        }
      }}
      aria-label="Todo title"
      className={`${className} w-full border-0 bg-[var(--fill-quaternary)] text-[var(--text-primary)] outline-none`}
    />
  )
}
