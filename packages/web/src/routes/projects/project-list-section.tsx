import { useState } from "react"
import { Plus, X } from "lucide-react"
import { ACTION_CLASS, FIELD_CLASS, ProjectSection } from "./project-parts"

/* An editable list of strings: each add or remove is one save of the whole list. */

type SaveList = (next: string[], onDone?: () => void) => void

function Entries({ items, onRemove, pending }: { items: string[]; onRemove: (item: string) => void; pending: boolean }) {
  if (items.length === 0) return <p className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">None yet.</p>
  return (
    <ul className="grid gap-1">
      {items.map((item) => (
        <li key={item} className="flex min-h-9 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] pl-3 pr-1">
          <code className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] text-[var(--text-primary)]">{item}</code>
          <button
            type="button"
            aria-label={`Remove ${item}`}
            disabled={pending}
            onClick={() => onRemove(item)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--fill-tertiary)] hover:text-[var(--system-red)] disabled:opacity-50"
          >
            <X size={14} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  )
}

function AddEntry({ noun, placeholder, items, save, pending }: { noun: string; placeholder: string; items: string[]; save: SaveList; pending: boolean }) {
  const [draft, setDraft] = useState("")
  const add = (event: React.FormEvent) => {
    event.preventDefault()
    const value = draft.trim()
    if (!value || items.includes(value)) return
    save([...items, value], () => setDraft(""))
  }
  return (
    <form onSubmit={add} className="flex gap-2">
      <input aria-label={`Add ${noun}`} className={FIELD_CLASS} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} />
      <button type="submit" className={ACTION_CLASS} disabled={!draft.trim() || pending}>
        <Plus size={14} className="mr-1" aria-hidden />
        Add
      </button>
    </form>
  )
}

export function ProjectListSection({
  title,
  hint,
  noun,
  items,
  placeholder,
  save,
  pending,
}: {
  title: string
  hint?: string
  /** What one entry is, for labels: "working directory". */
  noun: string
  items: string[]
  placeholder: string
  save: SaveList
  pending: boolean
}) {
  return (
    <ProjectSection title={title} hint={hint}>
      <Entries items={items} pending={pending} onRemove={(item) => save(items.filter((entry) => entry !== item))} />
      <AddEntry noun={noun} placeholder={placeholder} items={items} save={save} pending={pending} />
    </ProjectSection>
  )
}
