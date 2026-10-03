import { useEffect, useState } from "react"
import { Play, Trash2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { DIALOG_ACTION_CLASS, DIALOG_CANCEL_CLASS } from "@/components/ui/dialog-actions"
import type { SprintWire } from "@/lib/sprint-api"
import { operatorSafeTodoError } from "@/lib/todos"
import {
  sprintDates,
  useCompleteSprint,
  useCreateSprint,
  useDeleteSprint,
  useSprints,
  useStartSprint,
} from "./use-sprints"

/* The sprint planner: one dialog that creates sprints, starts the next one,
 * and completes the running one. Completing is the step with consequences, so
 * it opens its own panel that says how many Todos are unfinished and asks
 * where they go — the next planned sprint, a new one, or out of any sprint —
 * before anything closes. Deleting is offered for planned sprints only: a
 * closed sprint is the record of what shipped. */

const SECTION_LABEL_CLASS =
  "px-1 pb-1.5 pt-4 text-[length:var(--text-caption1)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]"
const ROW_BUTTON_CLASS =
  "focus-ring inline-flex h-[30px] flex-none items-center gap-1.5 rounded-full px-3 text-[12px] font-medium outline-none transition-colors disabled:opacity-50"
const QUIET_BUTTON_CLASS = `${ROW_BUTTON_CLASS} bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]`
const ACCENT_BUTTON_CLASS = `${ROW_BUTTON_CLASS} bg-[var(--accent-fill)] text-[var(--accent)] hover:bg-[var(--fill-secondary)]`
const FIELD_CLASS = "apple-input min-h-10 w-full"
const ERROR_CLASS = "rounded-[var(--radius-md)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
const QUIET_TEXT_CLASS = "px-1 py-3 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]"

export interface SprintsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Scope the board to a sprint (and close the dialog). */
  onShowOnBoard: (sprintId: string) => void
  /** Open straight onto the complete panel for this sprint. */
  completing?: string | null
}

export function SprintsDialog({ open, onOpenChange, onShowOnBoard, completing: completingProp }: SprintsDialogProps) {
  const sprints = useSprints(open)
  const { completing, setCompleting, error, setError } = usePlannerState(open, completingProp ?? null)

  const list = sprints.data ?? []
  const completingSprint = completing ? list.find((s) => s.id === completing) : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-32px)] max-w-[560px] overflow-y-auto border-0 bg-[var(--bg-secondary)] p-6"
        overlayClassName="bg-[var(--scrim)]"
        data-testid="sprints-dialog"
      >
        <PlannerHeading />
        {error && <ErrorNote message={error} />}
        {completingSprint ? (
          <CompletePanel
            sprint={completingSprint}
            planned={list.filter((s) => s.status === "planned")}
            onCancel={() => setCompleting(null)}
            onDone={(nextId) => {
              setCompleting(null)
              if (nextId) onShowOnBoard(nextId)
            }}
            onError={setError}
          />
        ) : (
          <>
            <CreateSprintForm onError={setError} />
            <SprintsState query={sprints} />
            {sprints.isSuccess && (
              <SprintList
                sprints={list}
                onShow={onShowOnBoard}
                onComplete={(id) => { setError(null); setCompleting(id) }}
                onError={setError}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PlannerHeading() {
  return (
    <>
      <DialogTitle className="text-[length:var(--text-title3)]">Sprints</DialogTitle>
      <DialogDescription className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
        Group Todos into time-boxed sprints. One sprint runs at a time; completing it carries unfinished work forward.
      </DialogDescription>
    </>
  )
}

/** Which panel shows and the last refusal, both reset each time the dialog opens. */
function usePlannerState(open: boolean, completingOnOpen: string | null) {
  const [completing, setCompleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setCompleting(completingOnOpen)
    setError(null)
  }, [open, completingOnOpen])
  return { completing, setCompleting, error, setError }
}

/** Loading and failure lines for the registry query; nothing once it has loaded. */
function SprintsState({ query }: { query: ReturnType<typeof useSprints> }) {
  if (query.isLoading) return <div className={QUIET_TEXT_CLASS}>Loading sprints…</div>
  if (query.isError) return <ErrorNote message={operatorSafeTodoError(query.error, "Couldn't load sprints")} />
  return null
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div role="alert" data-testid="sprints-error" className={ERROR_CLASS} style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
      {message}
    </div>
  )
}

/** Active, then planned (with Start and Delete), then the last few closed. */
function SprintList({ sprints, onShow, onComplete, onError }: {
  sprints: SprintWire[]
  onShow: (id: string) => void
  onComplete: (id: string) => void
  onError: (message: string | null) => void
}) {
  const active = sprints.find((s) => s.status === "active")
  const planned = sprints.filter((s) => s.status === "planned")
  const closed = sprints.filter((s) => s.status === "closed").slice(0, 6)
  if (sprints.length === 0) return <div className={QUIET_TEXT_CLASS}>No sprints yet. Name the first one above.</div>
  return (
    <>
      {active && (
        <section>
          <div className={SECTION_LABEL_CLASS}>Active</div>
          <SprintRow sprint={active} onShow={onShow}>
            <button type="button" data-testid={`sprint-complete-${active.id}`} className={ACCENT_BUTTON_CLASS} onClick={() => onComplete(active.id)}>
              Complete…
            </button>
          </SprintRow>
        </section>
      )}
      {planned.length > 0 && (
        <section>
          <div className={SECTION_LABEL_CLASS}>Planned</div>
          {planned.map((sprint) => (
            <SprintRow key={sprint.id} sprint={sprint} onShow={onShow}>
              <PlannedActions sprint={sprint} running={active} onError={onError} />
            </SprintRow>
          ))}
        </section>
      )}
      {closed.length > 0 && (
        <section>
          <div className={SECTION_LABEL_CLASS}>Closed</div>
          {closed.map((sprint) => <SprintRow key={sprint.id} sprint={sprint} onShow={onShow} />)}
        </section>
      )}
    </>
  )
}

function PlannedActions({ sprint, running, onError }: {
  sprint: SprintWire
  running: SprintWire | undefined
  onError: (message: string | null) => void
}) {
  const start = useStartSprint()
  const remove = useDeleteSprint()
  const fail = (fallback: string) => (err: unknown) => onError(operatorSafeTodoError(err, fallback))
  return (
    <>
      <button
        type="button"
        data-testid={`sprint-start-${sprint.id}`}
        className={QUIET_BUTTON_CLASS}
        disabled={!!running || start.isPending}
        title={running ? `Complete "${running.name}" first` : "Start this sprint"}
        onClick={() => { onError(null); start.mutate(sprint.id, { onError: fail("Couldn't start the sprint") }) }}
      >
        <Play size={11} aria-hidden /> Start
      </button>
      <button
        type="button"
        aria-label={`Delete ${sprint.name}`}
        data-testid={`sprint-delete-${sprint.id}`}
        className={`${ROW_BUTTON_CLASS} px-2 text-[var(--text-tertiary)] hover:bg-[var(--fill-tertiary)] hover:text-[var(--system-red)]`}
        disabled={remove.isPending}
        onClick={() => { onError(null); remove.mutate(sprint.id, { onError: fail("Couldn't delete the sprint") }) }}
      >
        <Trash2 size={13} aria-hidden />
      </button>
    </>
  )
}

function SprintRow({ sprint, onShow, children }: { sprint: SprintWire; onShow: (id: string) => void; children?: React.ReactNode }) {
  const detail = [sprintDates(sprint), sprint.goal].filter(Boolean).join(" · ")
  const counts = sprint.status === "closed" ? `${sprint.total - sprint.open} done` : `${sprint.open} open`
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-lg)] px-1 py-2" data-testid={`sprint-row-${sprint.id}`}>
      <button
        type="button"
        onClick={() => onShow(sprint.id)}
        className="focus-ring min-w-0 flex-1 rounded-[10px] text-left outline-none"
        title="Show this sprint on the board"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-[length:var(--text-subheadline)] font-semibold text-[var(--text-primary)]">{sprint.name}</span>
          <span className="flex-none text-[12px] tabular-nums text-[var(--text-tertiary)]">
            {counts}{sprint.total > 0 && ` · ${sprint.total} total`}
          </span>
        </div>
        {detail && <div className="truncate text-[12px] text-[var(--text-tertiary)]">{detail}</div>}
      </button>
      {children}
    </div>
  )
}

const EMPTY_SPRINT_FORM = { name: "", startsAt: "", endsAt: "", goal: "" }

function CreateSprintForm({ onError }: { onError: (message: string | null) => void }) {
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
        onError: (err) => onError(operatorSafeTodoError(err, "Couldn't create the sprint")),
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

type CarryChoice = { kind: "sprint"; id: string } | { kind: "new" } | { kind: "none" }

function CompletePanel({ sprint, planned, onCancel, onDone, onError }: {
  sprint: SprintWire
  planned: SprintWire[]
  onCancel: () => void
  onDone: (nextId: string | null) => void
  onError: (message: string | null) => void
}) {
  const complete = useCompleteSprint()
  const create = useCreateSprint()
  const [choice, setChoice] = useState<CarryChoice>(() => (planned[0] ? { kind: "sprint", id: planned[0].id } : { kind: "new" }))
  const [newName, setNewName] = useState("")
  const [startNext, setStartNext] = useState(true)

  const confirm = async () => {
    onError(null)
    if (choice.kind === "new" && !newName.trim()) return onError("Name the new sprint first")
    try {
      const carryTo = choice.kind === "sprint" ? choice.id
        : choice.kind === "new" ? (await create.mutateAsync({ name: newName.trim() })).sprint.id
        : null
      const result = await complete.mutateAsync({ id: sprint.id, carryTo, startNext: carryTo !== null && startNext })
      onDone(result.carriedTo && startNext ? result.carriedTo.id : null)
    } catch (err) {
      onError(operatorSafeTodoError(err, "Couldn't complete the sprint"))
    }
  }

  return (
    <div className="grid gap-3" data-testid="sprint-complete-panel">
      <div className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">
        Complete <strong>{sprint.name}</strong>.{" "}
        {sprint.open === 0
          ? "Every Todo in it is finished. Next sprint:"
          : `${sprint.open} unfinished Todo${sprint.open === 1 ? "" : "s"} will move to:`}
      </div>
      <CarryOptions planned={planned} choice={choice} onChoose={setChoice} newName={newName} onNewName={setNewName} />
      {choice.kind !== "none" && <StartNextToggle checked={startNext} onChange={setStartNext} />}
      <div className="mt-1 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={DIALOG_CANCEL_CLASS}>Back</button>
        <button type="button" data-testid="sprint-complete-confirm" disabled={complete.isPending || create.isPending} onClick={() => void confirm()} className={DIALOG_ACTION_CLASS}>
          Complete sprint
        </button>
      </div>
    </div>
  )
}

function StartNextToggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 px-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="sprint-start-next" className="accent-[var(--accent)]" />
      Start that sprint now
    </label>
  )
}

function CarryOptions({ planned, choice, onChoose, newName, onNewName }: {
  planned: SprintWire[]
  choice: CarryChoice
  onChoose: (choice: CarryChoice) => void
  newName: string
  onNewName: (name: string) => void
}) {
  return (
    <div className="grid gap-0.5 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-1.5" role="radiogroup" aria-label="Carry unfinished Todos to">
      {planned.map((next) => (
        <CarryOption key={next.id} checked={choice.kind === "sprint" && choice.id === next.id} onSelect={() => onChoose({ kind: "sprint", id: next.id })}>
          <span>{next.name} <span className="text-[12px] text-[var(--text-tertiary)]">{sprintDates(next) ?? "planned"}</span></span>
        </CarryOption>
      ))}
      <CarryOption checked={choice.kind === "new"} onSelect={() => onChoose({ kind: "new" })}>
        <span className="flex flex-1 items-center gap-2">
          A new sprint
          {choice.kind === "new" && (
            <input
              aria-label="New sprint name"
              data-testid="sprint-carry-new-name"
              className="apple-input min-h-9 flex-1"
              placeholder="Sprint name"
              value={newName}
              maxLength={80}
              autoFocus
              onChange={(e) => onNewName(e.target.value)}
            />
          )}
        </span>
      </CarryOption>
      <CarryOption checked={choice.kind === "none"} onSelect={() => onChoose({ kind: "none" })}>
        No sprint (back to the backlog)
      </CarryOption>
    </div>
  )
}

function CarryOption({ checked, onSelect, children }: { checked: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-[10px] px-2 text-[length:var(--text-subheadline)] text-[var(--text-primary)] hover:bg-[var(--fill-quaternary)]">
      <input type="radio" name="sprint-carry" checked={checked} onChange={onSelect} className="accent-[var(--accent)]" />
      {children}
    </label>
  )
}
