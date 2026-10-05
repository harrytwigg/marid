import { useState } from "react"
import { Check, Copy } from "lucide-react"
import type { ProjectWire } from "@/lib/project-api"
import { Switch } from "@/components/ui/switch"
import { copyText } from "@/platform"
import { QUIET_ACTION_CLASS, ProjectSection } from "./project-parts"
import type { ProjectSave } from "./use-project-save"

/* Members (read-only), Archive, and the pointer to the project's YAML file. */

export function ProjectMembersSection({ members }: { members: string[] }) {
  return (
    <ProjectSection title="Members" hint="Employees scoped to this project.">
      {members.length === 0 ? (
        <p className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">No scoped employees yet</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {members.map((member) => (
            <li key={member} className="rounded-full bg-[var(--fill-tertiary)] px-2.5 py-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
              {member}
            </li>
          ))}
        </ul>
      )}
    </ProjectSection>
  )
}

export function ProjectArchiveSection({ project, save, pending }: { project: ProjectWire; save: ProjectSave; pending: boolean }) {
  return (
    <ProjectSection title="Archive" hint="An archived project leaves the project switcher. Its Todos stay where they are.">
      <label className="flex items-center justify-between gap-3 text-[length:var(--text-footnote)] text-[var(--text-primary)]">
        Archived
        <Switch
          aria-label="Archived"
          checked={project.archived}
          disabled={pending}
          onCheckedChange={(archived) => save({ archived })}
        />
      </label>
    </ProjectSection>
  )
}

export function YamlHint({ file }: { file: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if ((await copyText(file)).status !== "performed") return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return (
    <ProjectSection title="Edit YAML" hint="Everything above is stored in this file, relative to your instance home.">
      <div className="flex items-center gap-2">
        <code data-testid="project-yaml-path" className="min-w-0 flex-1 truncate rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] px-3 py-2 text-[length:var(--text-footnote)] text-[var(--text-primary)]">
          {file}
        </code>
        <button type="button" onClick={() => void copy()} aria-label={`Copy path ${file}`} className={QUIET_ACTION_CLASS}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </ProjectSection>
  )
}
