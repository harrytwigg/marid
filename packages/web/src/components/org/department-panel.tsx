import type { ReactNode } from "react"
import { DepartmentScopeBadge } from "@/components/department-scope-badge"
import { useDepartment } from "@/hooks/use-department"
import { isConfined, type DepartmentDefinitionWire, type DepartmentScopeWire } from "@/lib/department-api"
import { ScopeSection, SCOPE_TEXT } from "@/components/org/department-scope-section"
import { departmentTitle } from "@/routes/todos/board/board-switcher"

/* The department panel, opened from a department's group box on the org tree.
 * It shows what the department's `department.yaml` says and how the gateway reads it.
 * The YAML is the source of truth and the panel names the file to edit. The one thing
 * it changes itself is the scope, which the gateway writes back into that file. */

const CARD = "rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-5)]"
const LABEL = "m-0 mb-[var(--space-2)] text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]"
const MUTED = "m-0 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
const MONO = "font-[family-name:var(--font-mono)]"

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId}>
      <h3 className={LABEL}>{title}</h3>
      {children}
    </section>
  )
}

function PathList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className={MUTED}>{empty}</p>
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map((item) => (
        <li key={item} className={`${MONO} break-all text-[length:var(--text-caption1)] text-[var(--text-primary)]`}>
          {item}
        </li>
      ))}
    </ul>
  )
}

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className={MUTED}>{empty}</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className={`${MONO} rounded-full bg-[var(--fill-tertiary)] px-2.5 py-0.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)]`}>
          {item}
        </span>
      ))}
    </div>
  )
}

/** Allow-listed skills the stage directory refuses. They are not offered to any session, so the operator is told here rather than finding a skill missing. */
function SkillProblems({ problems }: { problems: Array<{ skill: string; reason: string }> }) {
  if (problems.length === 0) return null
  return (
    <ul data-testid="department-skill-problems" className="m-0 mt-[var(--space-3)] flex list-none flex-col gap-1 p-0">
      {problems.map(({ skill, reason }) => (
        <li key={skill} className="text-[length:var(--text-caption1)] text-[var(--system-orange)]">
          <span className={`${MONO} font-[var(--weight-semibold)]`}>{skill}</span> is not offered to this department: {reason}.
        </li>
      ))}
    </ul>
  )
}

function RefusedNotice({ error, scope }: { error: string; scope: DepartmentScopeWire }) {
  return (
    <div
      role="alert"
      data-testid="department-definition-error"
      className="rounded-[var(--radius-md,12px)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
      style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)" }}
    >
      <strong className="font-[var(--weight-semibold)]">department.yaml was refused:</strong> {error}.{" "}
      The department stays {SCOPE_TEXT[scope].name.toLowerCase()} until the file is fixed.
    </div>
  )
}

function ScopedSections({ department }: { department: DepartmentDefinitionWire }) {
  return (
    <>
      <Section title="Working directories" testId="department-workdirs">
        <PathList items={department.workdirs} empty="None. Scoped sessions get no working directory." />
      </Section>
      <Section title="Skills" testId="department-skills">
        <Chips items={department.skills} empty="None. Scoped sessions get no company skills." />
        <SkillProblems problems={department.skillProblems ?? []} />
      </Section>
      <Section title="MCP servers" testId="department-mcp">
        <Chips items={department.mcp} empty="None. Scoped sessions get only the jinn server." />
      </Section>
      <Section title="Shared Notes" testId="department-shared-notes">
        <PathList items={department.sharedNotes} empty="None. Only the department's own Notes are shared." />
      </Section>
      <Section title="Instructions" testId="department-instructions">
        <p className="m-0 text-[length:var(--text-body)] text-[var(--text-primary)]">
          {department.instructions === "department+company" ? "The department's instructions, then the company's" : "The department's own instructions only"}
        </p>
      </Section>
    </>
  )
}

function YamlHint({ slug, file }: { slug: string; file: string | null }) {
  const path = file ?? `org/${slug}/department.yaml`
  return (
    <Section title="Edit YAML" testId="department-yaml">
      <p className={MUTED}>
        {file ? "This department is defined in" : "This department has no definition yet. Create"}{" "}
        <code className={`${MONO} break-all text-[var(--text-secondary)]`}>{path}</code> {file ? "in the instance home. Edit that file; the panel updates when it changes." : "in the instance home to give it a scope."}
      </p>
    </Section>
  )
}

function Header({ department }: { department: DepartmentDefinitionWire }) {
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-1">
        <h2 className="m-0 text-[length:var(--text-title2)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
          {department.displayName ?? departmentTitle(department.slug)}
        </h2>
        <DepartmentScopeBadge scope={department.scope} />
      </div>
      <p className={`${MUTED} mt-[2px] ${MONO}`}>
        {department.slug}
        {department.prefix ? ` · ${department.prefix}` : ""}
      </p>
      {department.description && <p className="mb-0 mt-[var(--space-3)] text-[length:var(--text-body)] text-[var(--text-secondary)]">{department.description}</p>}
    </div>
  )
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <Section title="Dropped entries" testId="department-warnings">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {warnings.map((warning) => (
          <li key={warning} className="text-[length:var(--text-caption1)] text-[var(--system-orange)]">{warning}</li>
        ))}
      </ul>
    </Section>
  )
}

function Members({ members, onSelect }: { members: string[]; onSelect: (name: string) => void }) {
  return (
    <Section title={`Members (${members.length})`} testId="department-members">
      {members.length === 0 ? (
        <p className={MUTED}>No employees.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {members.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onSelect(name)}
              className={`${MONO} cursor-pointer rounded-full border border-[var(--separator)] bg-transparent px-2.5 py-0.5 text-[length:var(--text-caption1)] text-[var(--text-primary)] hover:border-[var(--accent)]`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </Section>
  )
}

function Work({ todoCount, spendUsd }: { todoCount: number; spendUsd: number }) {
  return (
    <Section title="Work" testId="department-work">
      <p className="m-0 text-[length:var(--text-body)] text-[var(--text-primary)]">
        {todoCount} {todoCount === 1 ? "Todo" : "Todos"}
        <span className="text-[var(--text-tertiary)]"> · ${spendUsd.toFixed(2)} spent</span>
      </p>
    </Section>
  )
}

function Definition({ department }: { department: DepartmentDefinitionWire }) {
  if (department.definitionError) {
    return (
      <p className={MUTED} data-testid="department-settings-unknown">
        Working directories, skills, MCP servers, shared Notes and instructions are unknown while the file is refused.
      </p>
    )
  }
  if (isConfined(department.scope)) return <ScopedSections department={department} />
  return (
    <p className={MUTED} data-testid="department-open-note">
      Working directories, skills, MCP servers, shared Notes and instructions apply once a department is scoped.
    </p>
  )
}

export interface DepartmentPanelProps {
  slug: string
  /** Opens an employee's panel. */
  onSelectEmployee: (name: string) => void
}

export function DepartmentPanel({ slug, onSelectEmployee }: DepartmentPanelProps) {
  const query = useDepartment(slug)
  if (query.isLoading) return <p className={`${MUTED} py-[var(--space-8)] text-center`}>Loading...</p>
  if (query.isError || !query.data) return <p role="alert" className={`${MUTED} py-[var(--space-8)] text-center`}>This department could not be loaded.</p>
  const department = query.data

  return (
    <div className="flex flex-col gap-[var(--space-6)]" data-testid="department-panel" data-scope={department.scope}>
      <Header department={department} />
      {department.definitionError && <RefusedNotice error={department.definitionError} scope={department.scope} />}
      <Section title="Scope" testId="department-scope">
        <ScopeSection department={department} />
      </Section>
      <Definition department={department} />
      <Warnings warnings={department.warnings} />
      <Members members={department.members} onSelect={onSelectEmployee} />
      <Work todoCount={department.todoCount} spendUsd={department.spendUsd} />
      <YamlHint slug={slug} file={department.definitionFile} />
    </div>
  )
}
