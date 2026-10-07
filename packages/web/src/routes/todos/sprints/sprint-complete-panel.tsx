import { useState } from "react"
import { DIALOG_ACTION_CLASS, DIALOG_CANCEL_CLASS } from "@/components/ui/dialog-actions"
import type { SprintWire } from "@/lib/sprint-api"
import { sprintDates, useCompleteSprint, useCreateSprint, sprintErrorMessage } from "./use-sprints"

/* Completing the running sprint: how many Todos are unfinished, where they go
 * (a planned sprint, a new one, or out of any sprint), and whether that sprint
 * starts in the same move. Nothing closes until the operator confirms. */

/** The sprint a "new sprint" carry goes into. Completing into a new sprint is
 *  two requests, create then complete, so the panel remembers the sprint its
 *  own create made and a retry after a failed complete reuses that id. It never
 *  matches by name: a name an existing sprint already has is refused (409), so
 *  work is never carried into a sprint the operator did not pick. */
type Created = { name: string; id: string } | null

async function newSprintId(
  name: string,
  created: Created,
  remember: (created: Created) => void,
  create: (input: { name: string }) => Promise<{ sprint: SprintWire }>,
): Promise<string> {
  if (created && created.name === name) return created.id
  const id = (await create({ name })).sprint.id
  remember({ name, id })
  return id
}

type CarryChoice = { kind: "sprint"; id: string } | { kind: "new" } | { kind: "none" }

export function CompletePanel({ sprint, planned, onCancel, onDone, onError }: {
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
  const [created, setCreated] = useState<Created>(null)

  const confirm = async () => {
    onError(null)
    if (choice.kind === "new" && !newName.trim()) return onError("Name the new sprint first")
    try {
      const carryTo = choice.kind === "sprint" ? choice.id
        : choice.kind === "new" ? await newSprintId(newName.trim(), created, setCreated, create.mutateAsync)
        : null
      const result = await complete.mutateAsync({ id: sprint.id, carryTo, startNext: carryTo !== null && startNext })
      onDone(result.carriedTo && startNext ? result.carriedTo.id : null)
    } catch (err) {
      onError(sprintErrorMessage(err, "Couldn't complete the sprint"))
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
        No sprint (back to To do)
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
