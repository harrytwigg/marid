import { Fragment, type ReactNode } from "react"
import { Play, Plus } from "lucide-react"
import { STATUS_LABEL } from "@/lib/todos"
import { StatusCircle } from "@/routes/todos/state-glyph"
import { useTriggerCronJob } from "@/hooks/use-cron"
import { CommandObjectPicker } from "./command-object-picker"
import { statusTint } from "./kind-meta"
import type { CommandMode, CommandObject } from "./use-command"
import type { TodoWorkbench } from "./use-todo-workbench"
import { WorkbenchField } from "./workbench"
import type { Verb } from "./verbs"

/* The preview pane, in command mode. It says which verb is armed and what it is
 * pointed at before it offers a control, so nothing here can act on a Todo the
 * operator cannot see the name of. Assign and move are the workbench's own
 * fields — the same lanes the task page writes through. */

const PANE = "px-[22px] py-5"
const KICKER = "text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--text-quaternary)]"
const TITLE = "mt-[9px] text-[19px] font-medium leading-[1.28] tracking-[-0.014em] text-[var(--text-primary)]"
const META = "mt-[9px] flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--text-tertiary)]"
const QUIET = "mt-3.5 text-[13px] leading-[1.45] text-[var(--text-tertiary)]"
const ERROR = "mt-2 text-[12.5px] leading-[1.4] text-[var(--system-red)]"
const PRIMARY = "mt-3.5 inline-flex min-h-[34px] items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent-fill)] px-3.5 text-[13px] font-medium text-[var(--accent)] outline-none focus-visible:bg-[var(--accent)] focus-visible:text-[var(--accent-contrast)] disabled:opacity-40"

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col justify-center px-[22px] py-5 text-[13.5px] text-[var(--text-tertiary)]">{children}</div>
}

/** The object, named. `live` overrides the pinned payload's copy once the
 *  workbench has the Todo itself, so a move made below shows above. */
function ObjectMeta({ row, live }: { row: CommandObject; live: string | undefined }) {
  const parts: ReactNode[] = []
  if (row.kind === "todo") {
    parts.push(<span key="id" className="font-[family-name:var(--font-code)] text-[11px]">{row.result.id}</span>)
  } else if (row.result.preview.subtitle) {
    parts.push(<span key="subtitle" className="truncate">{row.result.preview.subtitle}</span>)
  }
  const status = live ?? row.result.preview.status
  if (status) {
    parts.push(
      <span key="status" className="flex items-center gap-1.5">
        <span className="size-[7px] flex-none rounded-full" style={{ background: statusTint(status) }} />
        {status}
      </span>,
    )
  }
  return (
    <div className={META}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="text-[var(--text-quaternary)]">·</span>}
          {part}
        </Fragment>
      ))}
    </div>
  )
}

function RunForm({ row }: { row: CommandObject }) {
  const { trigger, triggered } = useTriggerCronJob(row.result.id)
  return (
    <>
      <p className={QUIET} data-testid="command-run-confirm">
        This starts <b className="font-medium text-[var(--text-primary)]">{row.result.title}</b> now, off
        its schedule. It runs for real.
      </p>
      <button
        type="button"
        data-command-primary=""
        data-testid="command-run-now"
        disabled={trigger.isPending || triggered}
        onClick={() => trigger.mutate()}
        className={PRIMARY}
      >
        <Play size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
        {triggered ? "Triggered" : trigger.isPending ? "Starting…" : "Run now"}
      </button>
      {triggered && (
        <p className={QUIET} data-testid="command-run-done">Triggered — the run lands in the log a beat later.</p>
      )}
      {trigger.isError && (
        <p className={ERROR} data-testid="command-run-error">
          {trigger.error instanceof Error ? trigger.error.message : "Couldn't trigger the job"}
        </p>
      )}
    </>
  )
}

function NewForm({ title, onCreate }: { title: string; onCreate: () => void }) {
  return (
    <>
      <p className={QUIET}>
        {title
          ? "Opens the create dialog with this title, so the rest can be filled in there."
          : "Type a title after the verb, or fill it in the dialog."}
      </p>
      <button type="button" data-command-primary="" data-testid="command-new-open" onClick={onCreate} className={PRIMARY}>
        <Plus size={14} aria-hidden="true" />
        Create Todo
      </button>
    </>
  )
}

/** Assign and move, through the one lane that writes them. */
function TodoForm({ verb, workbench }: { verb: Verb; workbench: TodoWorkbench }) {
  if (workbench.loading) return <p className={QUIET}>Loading {workbench.id}…</p>
  if (workbench.missing) {
    return (
      <p className={QUIET} data-testid="command-todo-missing">
        Couldn&apos;t load {workbench.id}. It may have been deleted — open it to check.
      </p>
    )
  }
  const status = workbench.status
  return (
    <div className="mt-3.5 flex" data-testid={`command-form-${verb.name}`}>
      {verb.name === "assign" ? (
        <WorkbenchField
          field="assignee"
          label="Owner"
          value={workbench.assignee ?? <span className="text-[var(--text-tertiary)]">Unassigned</span>}
          workbench={workbench}
          primary
        />
      ) : (
        <WorkbenchField
          field="status"
          label="Status"
          value={status ? <><StatusCircle status={status} size={14} />{STATUS_LABEL[status]}</> : "—"}
          workbench={workbench}
          primary
        />
      )}
    </div>
  )
}

export interface CommandPaneProps {
  mode: CommandMode
  /** Pointed at the command's Todo, so assign and move have one implementation. */
  workbench: TodoWorkbench | undefined
  onCreateTodo: (title: string) => void
}

/** The armed verb's own control. The question of which object comes first, so a
 *  verb can never act on one it has not been given. */
function CommandForm({ verb, mode, workbench, onCreateTodo }: CommandPaneProps & { verb: Verb }) {
  if (mode.needsObject && verb.object) {
    return <CommandObjectPicker kind={verb.object} onPick={mode.chooseObject} />
  }
  if (verb.name === "new") {
    const title = mode.command.argument
    return <NewForm title={title} onCreate={() => onCreateTodo(title)} />
  }
  if (verb.name === "run") return mode.object ? <RunForm row={mode.object} /> : null
  return workbench ? <TodoForm verb={verb} workbench={workbench} /> : null
}

export function CommandPane({ mode, workbench, onCreateTodo }: CommandPaneProps) {
  const { verb, command, object } = mode
  if (!verb) {
    return (
      <Notice>
        <p data-testid="command-hint">
          Pick a command. Each one acts on the row you last had selected, and asks which one if there
          is none.
        </p>
      </Notice>
    )
  }
  // A verb still waiting for its object has nothing to be titled after; the
  // picker's own label carries the pane instead.
  const heading = object ? object.result.title
    : verb.name === "new" ? command.argument || "New Todo"
    : null
  return (
    <div className={PANE} data-command-form="" data-testid="command-pane">
      <div className={KICKER}>Command · {verb.name}</div>
      {heading && <h2 className={TITLE}>{heading}</h2>}
      {object && <ObjectMeta row={object} live={workbench?.status} />}
      <CommandForm verb={verb} mode={mode} workbench={workbench} onCreateTodo={onCreateTodo} />
      {workbench?.error && <p className={ERROR} data-testid="command-error">{workbench.error}</p>}
    </div>
  )
}
