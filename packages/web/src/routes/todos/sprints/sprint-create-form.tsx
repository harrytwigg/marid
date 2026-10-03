import { useState } from "react"
import { DIALOG_ACTION_CLASS } from "@/components/ui/dialog-actions"
import { useCreateSprint, sprintErrorMessage } from "./use-sprints"

/* The planner's new-sprint row: a name (required), optional start and end
 * days, and an optional goal. */

const FIELD_CLASS = "apple-input min-h-10 w-full"

const EMPTY_SPRINT_FORM = { name: "", startsAt: "", endsAt: "", goal: "" }

export function CreateSprintForm({ onError }: { onError: (message: string | null) => void }) {
  const create = useCreateSprint()
  const [form, setForm] = useState(EMPTY_SPRINT_FORM)
  const field = (key: keyof typeof EMPTY_SPRINT_FORM) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  })
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!form.name.trim()) return
    onError(null)
    create.mutate(
      { name: form.name.trim(), goal: form.goal.trim() || null, startsAt: form.startsAt || null, endsAt: form.endsAt || null },
      {
        onSuccess: () => setForm(EMPTY_SPRINT_FORM),
        onError: (err) => onError(sprintErrorMessage(err, "Couldn't create the sprint")),
      },
    )
  }
  return (
    <form onSubmit={submit} className="grid gap-2 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-3" data-testid="sprint-create-form">
      <div className="flex gap-2">
        <input aria-label="Sprint name" data-testid="sprint-name-input" className={FIELD_CLASS} placeholder="New sprint name, e.g. Sprint 12" maxLength={80} {...field("name")} />
        <button type="submit" data-testid="sprint-create" disabled={!form.name.trim() || create.isPending} className={`${DIALOG_ACTION_CLASS} min-h-10 flex-none`}>
          Create
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input aria-label="Start date" type="date" className={FIELD_CLASS} {...field("startsAt")} />
        <input aria-label="End date" type="date" className={FIELD_CLASS} {...field("endsAt")} />
      </div>
      <input aria-label="Sprint goal" className={FIELD_CLASS} placeholder="Goal (optional)" maxLength={2000} {...field("goal")} />
    </form>
  )
}
