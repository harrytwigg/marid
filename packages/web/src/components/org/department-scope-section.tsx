import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { OptionPills } from "@/components/ui/option-pills"
import { departmentApi, DepartmentPatchError, type DepartmentDefinitionWire, type DepartmentHolderWire, type DepartmentScopeWire } from "@/lib/department-api"

/* The department panel's Scope section: the scope as a three-way choice. Picking
 * another option only stages it; Save sends the change. The gateway refuses a
 * change that would strand Todos, and the refusal names who holds them. */

export const SCOPE_TEXT: Record<DepartmentScopeWire, { name: string; body: string }> = {
  open: { name: "Open", body: "No restriction. Its employees work across the company and its Todos can be held by anyone." },
  scoped: { name: "Scoped", body: "Its employees are confined to this department. Everyone else can still read it, comment on it and hold its Todos." },
  dedicated: { name: "Dedicated", body: "Its employees are confined to this department, and only they can hold its Todos. Everyone else can read and comment." },
}

const OPTIONS = (["open", "scoped", "dedicated"] as const).map((value) => ({ value, label: SCOPE_TEXT[value].name }))
const MUTED = "m-0 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
const BUTTON = "focus-ring min-h-9 cursor-pointer rounded-full border-none px-4 py-1.5 text-[length:var(--text-footnote)] font-[var(--weight-medium)] outline-none disabled:cursor-default disabled:opacity-50"
/** `system` and `org` hold the company's own employees and cannot be scoped. */
const UNSCOPABLE = new Set(["system", "org"])

function failureOf(error: unknown): { message: string; holders: DepartmentHolderWire[] } {
  if (error instanceof DepartmentPatchError) return { message: error.message, holders: error.code === "department-boundary" ? error.holders : [] }
  return { message: error instanceof Error ? error.message : "The scope could not be changed.", holders: [] }
}

function Refusal({ message, holders }: { message: string; holders: DepartmentHolderWire[] }) {
  return (
    <div
      role="alert"
      data-testid="department-scope-error"
      className="mt-[var(--space-3)] rounded-[var(--radius-md,12px)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
      style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)" }}
    >
      <p className="m-0">{message}</p>
      {holders.length > 0 && (
        <ul data-testid="department-scope-holders" className="m-0 mt-[var(--space-2)] flex list-none flex-col gap-1 p-0">
          {holders.map((holder) => (
            <li key={holder.todo} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <Link to={`/todos/${encodeURIComponent(holder.todo)}`} className="font-[var(--weight-semibold)] text-[var(--system-red)] underline">
                {holder.todo}
              </Link>
              <span className="min-w-0 break-all text-[var(--text-secondary)]">held by {holder.assignee}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function useScopeChange(slug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (scope: DepartmentScopeWire) => departmentApi.patch(slug, { scope }),
    onSuccess: (department) => {
      queryClient.setQueryData(["departments", "definition", slug], department)
      void queryClient.invalidateQueries({ queryKey: ["departments"], exact: true })
    },
  })
}

function readOnlyReason(department: DepartmentDefinitionWire): string | null {
  if (UNSCOPABLE.has(department.slug)) return "The system and org departments cannot be scoped."
  return department.definitionError ? "The scope cannot be changed until department.yaml is fixed." : null
}

function StagedActions({ pending, onSave, onCancel }: { pending: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div data-testid="department-scope-staged" className="mt-[var(--space-3)] flex flex-wrap items-center gap-2">
      <button type="button" disabled={pending} onClick={onSave} className={`${BUTTON} bg-[var(--accent)] text-[var(--accent-contrast,#fff)]`}>
        {pending ? "Saving..." : "Save scope"}
      </button>
      <button type="button" disabled={pending} onClick={onCancel} className={`${BUTTON} bg-[var(--fill-tertiary)] text-[var(--text-secondary)]`}>
        Cancel
      </button>
      <span className={MUTED}>Not saved yet.</span>
    </div>
  )
}

function ScopeText({ scope, readOnly }: { scope: DepartmentScopeWire; readOnly: string | null }) {
  const text = SCOPE_TEXT[scope]
  return (
    <>
      <p className={`m-0 text-[length:var(--text-body)] text-[var(--text-primary)] ${readOnly ? "" : "mt-[var(--space-3)]"}`}>
        <span className="font-[var(--weight-semibold)]">{text.name}</span>
        <span className="text-[var(--text-secondary)]">. {text.body}</span>
      </p>
      {readOnly && <p className={`${MUTED} mt-[var(--space-2)]`}>{readOnly}</p>}
    </>
  )
}

export function ScopeSection({ department }: { department: DepartmentDefinitionWire }) {
  const { slug, scope } = department
  const [staged, setStaged] = useState<DepartmentScopeWire | null>(null)
  const change = useScopeChange(slug)
  const shown = staged && staged !== scope ? staged : null
  const readOnly = readOnlyReason(department)
  const failure = change.isError ? failureOf(change.error) : null
  const stage = (value: string) => {
    change.reset()
    setStaged(value === scope ? null : (value as DepartmentScopeWire))
  }

  return (
    <>
      {!readOnly && <OptionPills label="Scope" options={OPTIONS} selected={shown ?? scope} disabled={change.isPending} onSelect={stage} />}
      <ScopeText scope={shown ?? scope} readOnly={readOnly} />
      {shown && <StagedActions pending={change.isPending} onSave={() => change.mutate(shown, { onSuccess: () => setStaged(null) })} onCancel={() => stage(scope)} />}
      {failure && <Refusal message={failure.message} holders={failure.holders} />}
    </>
  )
}
