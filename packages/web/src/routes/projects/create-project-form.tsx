import { useState } from "react"
import { useCreateProject } from "@/hooks/use-projects"
import { ACTION_CLASS, ErrorLine, FIELD_CLASS, QUIET_ACTION_CLASS, errorText } from "./project-parts"

/* The new-project form: a name and a description. The server mints the id and
 * writes the YAML file; everything else is edited on the card afterwards. */

export function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const create = useCreateProject()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [error, setError] = useState<string | null>(null)
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setError(null)
    create.mutate(
      { name: name.trim(), description: description.trim() },
      { onSuccess: onDone, onError: (err) => setError(errorText(err, "Couldn't create the project")) },
    )
  }
  return (
    <form
      onSubmit={submit}
      aria-label="New project"
      data-testid="project-create-form"
      className="grid gap-2 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-4 shadow-[var(--shadow-card)]"
    >
      <input aria-label="Name" className={FIELD_CLASS} placeholder="Project name, e.g. Garden Planner" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      <textarea aria-label="Description" className={`${FIELD_CLASS} min-h-16 py-2`} placeholder="What this project is for (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      {error ? <ErrorLine message={error} /> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={QUIET_ACTION_CLASS}>Cancel</button>
        <button type="submit" className={ACTION_CLASS} disabled={!name.trim() || create.isPending}>Create project</button>
      </div>
    </form>
  )
}
