import { useState } from "react"
import { AlertTriangle, ChevronRight } from "lucide-react"
import type { ProjectWire } from "@/lib/project-api"
import { cn } from "@/lib/utils"
import { ProjectDetailsSection } from "./project-details-section"
import { ProjectArchiveSection, ProjectMembersSection, YamlHint } from "./project-extra-sections"
import { ProjectListSection } from "./project-list-section"
import { ErrorLine } from "./project-parts"
import { useProjectSave } from "./use-project-save"

/* One project: a summary line that opens into its sections. */

export function formatSpend(usd: number): string {
  return `$${usd.toFixed(2)}`
}

function Summary({ project }: { project: ProjectWire }) {
  const todos = `${project.todoCount} ${project.todoCount === 1 ? "Todo" : "Todos"}`
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        <span className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          {project.name}
        </span>
        {project.archived ? (
          <span className="shrink-0 rounded-full bg-[var(--fill-tertiary)] px-2 py-0.5 text-[length:var(--text-caption2)] text-[var(--text-secondary)]">
            Archived
          </span>
        ) : null}
      </span>
      <span className="mt-0.5 block truncate text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
        {todos} · {formatSpend(project.spendUsd)} spent
        {project.description ? ` · ${project.description}` : ""}
      </span>
    </span>
  )
}

function Notices({ notices }: { notices: string[] }) {
  return (
    <ul className="grid gap-1 px-4 pb-3">
      {notices.map((notice) => (
        <li key={notice} className="flex items-start gap-2 text-[length:var(--text-footnote)] text-[var(--system-orange)]">
          <AlertTriangle size={14} className="mt-[2px] shrink-0" aria-hidden />
          <span>{notice}</span>
        </li>
      ))}
    </ul>
  )
}

export function ProjectCard({ project, defaultOpen }: { project: ProjectWire; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const { save, error, pending } = useProjectSave(project.id)
  const list = (key: "workdirs" | "skills" | "sharedNotes") => (next: string[], onDone?: () => void) => save({ [key]: next }, onDone)
  return (
    <article
      data-testid={`project-card-${project.id}`}
      className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${project.name} project`}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 rounded-[var(--radius-xl)] px-4 py-3 text-left transition-colors hover:bg-[var(--fill-quaternary)]"
      >
        <Summary project={project} />
        <ChevronRight size={14} aria-hidden className={cn("shrink-0 text-[var(--text-quaternary)] transition-transform", open && "rotate-90")} />
      </button>
      {project.notices.length > 0 ? <Notices notices={project.notices} /> : null}
      {open ? (
        <div className="grid gap-4 px-4 pb-4">
          {error ? <ErrorLine message={error} /> : null}
          <ProjectDetailsSection key={`${project.name}\u0000${project.description}`} project={project} save={save} pending={pending} />
          <ProjectListSection title="Working directories" noun="working directory" items={project.workdirs} placeholder="~/Projects/garden-planner" save={list("workdirs")} pending={pending} />
          <ProjectListSection title="Skills" noun="skill" items={project.skills} placeholder="skill name" save={list("skills")} pending={pending} />
          <ProjectListSection title="Shared Notes" noun="shared note" items={project.sharedNotes} placeholder="knowledge/garden-planner.md" hint="Notes every Todo in this project can read." save={list("sharedNotes")} pending={pending} />
          <ProjectMembersSection members={project.members} />
          <ProjectArchiveSection project={project} save={save} pending={pending} />
          <YamlHint file={project.file} />
        </div>
      ) : null}
    </article>
  )
}
