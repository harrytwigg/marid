import { useState } from "react"
import type { ProjectWire } from "@/lib/project-api"
import { ACTION_CLASS, FIELD_CLASS, ProjectSection } from "./project-parts"
import type { ProjectSave } from "./use-project-save"

/* Name and description are editable. `dedicated` is shown but never sent: the
 * server refuses writes to it until scoped employees exist. */

export function ProjectDetailsSection({ project, save, pending }: { project: ProjectWire; save: ProjectSave; pending: boolean }) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const dirty = name.trim() !== project.name || description !== project.description
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !dirty) return
    save({ name: name.trim(), description })
  }
  return (
    <ProjectSection title="Details">
      <form onSubmit={submit} className="grid gap-2">
        <input
          aria-label="Project name"
          className={FIELD_CLASS}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          aria-label="Project description"
          className={`${FIELD_CLASS} min-h-20 py-2`}
          value={description}
          placeholder="What this project is for"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-[length:var(--text-footnote)] text-[var(--text-secondary)]" data-testid="project-dedicated">
            <span className="font-[var(--weight-medium)]">Dedicated:</span> {project.dedicated ? "yes" : "no"}
            <span className="text-[var(--text-tertiary)]"> · read-only, not editable yet</span>
          </p>
          <button type="submit" className={ACTION_CLASS} disabled={!dirty || !name.trim() || pending}>
            Save details
          </button>
        </div>
      </form>
    </ProjectSection>
  )
}
