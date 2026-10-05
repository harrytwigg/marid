import { useState } from "react"
import { Plus } from "lucide-react"
import { useProjects } from "@/hooks/use-projects"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { Skeleton } from "@/components/ui/skeleton"
import { CreateProjectForm } from "./create-project-form"
import { ProjectCard } from "./project-card"
import { ACTION_CLASS, ErrorLine, errorText } from "./project-parts"

/* Projects group Todos. Each one is a YAML file under projects/ in the instance
 * home; this page reads them with their live counts and edits the fields the
 * server allows. */

function EmptyState() {
  return (
    <div data-testid="projects-empty" className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-6 py-12 text-center shadow-[var(--shadow-card)]">
      <h2 className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)]">No projects yet</h2>
      <p className="mx-auto mt-2 max-w-[44ch] text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
        A project groups Todos. Projects are YAML files under <code>projects/</code> in your instance home, or you can create one here.
      </p>
    </div>
  )
}

function subtitle(count: number | undefined): string {
  if (count === undefined) return "Groups of related Todos"
  return `${count} ${count === 1 ? "project" : "projects"} · groups of related Todos`
}

export default function ProjectsPage() {
  const projects = useProjects()
  const [creating, setCreating] = useState(false)
  const list = projects.data ?? []
  return (
    <PageLayout>
      <PageScaffold
        contentWidth="840px"
        header={
          <LargeTitleHeader
            title="Projects"
            subtitle={subtitle(projects.data?.length)}
            trailing={
              <button type="button" className={ACTION_CLASS} onClick={() => setCreating(true)} disabled={creating}>
                <Plus size={14} className="mr-1" aria-hidden />
                New project
              </button>
            }
          />
        }
      >
        <div className="grid gap-3">
          {creating ? <CreateProjectForm onDone={() => setCreating(false)} /> : null}
          {projects.isError ? <ErrorLine message={errorText(projects.error, "Couldn't load projects")} /> : null}
          {projects.isLoading ? <Skeleton height={64} className="rounded-[var(--radius-xl)]" /> : null}
          {projects.isSuccess && list.length === 0 && !creating ? <EmptyState /> : null}
          {list.map((project) => (
            <ProjectCard key={project.id} project={project} defaultOpen={list.length === 1} />
          ))}
        </div>
      </PageScaffold>
    </PageLayout>
  )
}
