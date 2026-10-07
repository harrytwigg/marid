import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SESSION_MENU_CONTENT_CLASS, SESSION_MENU_ITEM_CLASS } from "@/components/chat/session-row-menu"
import { DIALOG_ACTION_CLASS, DIALOG_CANCEL_CLASS } from "@/components/ui/dialog-actions"
import { DepartmentArchiveError, departmentApi } from "@/lib/department-api"
import { departmentTitle } from "./board-switcher"

/* A department board's `⋯`: archive the department, or take it back. Archiving is
 * reversible and deletes nothing, but it stops anything new being filed there, so it
 * goes through a dialog. When the department still has members or open Todos the
 * gateway refuses the first ask and names them; the dialog shows that and the
 * operator confirms a second time. Un-archiving needs no second word. */

const TRIGGER_CLASS =
  "focus-ring inline-flex size-10 items-center justify-center rounded-full bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-[var(--shadow-ambient),var(--shadow-subtle),var(--inset-shine)] outline-none transition-transform hover:scale-[0.96] motion-reduce:transition-none"
const NOTICE_CLASS = "mt-4 rounded-[var(--radius-md)] p-[10px_13px] text-[length:var(--text-footnote)]"

type Stage = "closed" | "archive" | "unarchive"

function useArchiveChange(slug: string, onDone: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ archived, confirm }: { archived: boolean; confirm: boolean }) =>
      archived ? departmentApi.archive(slug, confirm) : departmentApi.unarchive(slug),
    onSuccess: async () => {
      // The list, every picker and the department panel all read under ["departments"].
      await queryClient.invalidateQueries({ queryKey: ["departments"] })
      onDone()
    },
  })
}

/** What the gateway said is still in the department, when that is why it asked again. */
function confirmationOf(error: unknown): DepartmentArchiveError | null {
  return error instanceof DepartmentArchiveError && error.code === "department-archive-confirm" ? error : null
}

function StillThere({ refusal }: { refusal: DepartmentArchiveError }) {
  const parts = [
    ...(refusal.members.length > 0 ? [`${refusal.members.length} ${refusal.members.length === 1 ? "member" : "members"} (${refusal.members.join(", ")})`] : []),
    ...(refusal.openTodos > 0 ? [`${refusal.openTodos} open ${refusal.openTodos === 1 ? "Todo" : "Todos"}`] : []),
  ]
  return (
    <div
      role="alert"
      data-testid="department-archive-confirm"
      className={`${NOTICE_CLASS} text-[var(--system-orange)]`}
      style={{ background: "color-mix(in srgb, var(--system-orange) 10%, transparent)" }}
    >
      It still has {parts.join(" and ")}. They stay as they are and can keep working, but nothing new can be filed here.
    </div>
  )
}

/** The dialog's words for each stage; the submit label follows the request's progress. */
function dialogText(stage: Exclude<Stage, "closed">, title: string, prefix: string | undefined) {
  if (stage === "unarchive") {
    return { title: `Un-archive ${title}?`, body: "It comes back to the department lists and takes new Todos again.", label: () => "Un-archive", pending: "Restoring…" }
  }
  return {
    title: `Archive ${title}?`,
    body: `It leaves the department lists and no new Todos can be filed in it. Its Todos keep their ${prefix ?? ""} ids and stay open, searchable and editable. You can un-archive it at any time.`,
    label: (confirming: boolean) => (confirming ? "Archive anyway" : "Archive"),
    pending: "Archiving…",
  }
}

function Failure({ error }: { error: unknown }) {
  return (
    <div role="alert" data-testid="department-archive-error" className={`${NOTICE_CLASS} text-[var(--system-red)]`} style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
      {error instanceof Error ? error.message : "The department could not be changed."}
    </div>
  )
}

function ArchiveDialog({ slug, prefix, stage, onClose }: { slug: string; prefix: string | undefined; stage: Exclude<Stage, "closed">; onClose: () => void }) {
  const change = useArchiveChange(slug, onClose)
  // Held in state, not read off the latest error: an "Archive anyway" that fails for some
  // other reason (a 500, the network) must not drop back to an unconfirmed archive.
  const [refusal, setRefusal] = useState<DepartmentArchiveError | null>(null)
  const text = dialogText(stage, departmentTitle(slug), prefix)
  const submit = () =>
    change.mutate(
      { archived: stage === "archive", confirm: refusal !== null },
      { onError: (error) => setRefusal((held) => confirmationOf(error) ?? held) },
    )
  const failure = change.error != null && !confirmationOf(change.error) ? change.error : null

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-[400px] border-0" overlayClassName="bg-[var(--scrim)]" showCloseButton={false}>
        <DialogTitle>{text.title}</DialogTitle>
        <DialogDescription>{text.body}</DialogDescription>
        {refusal && <StillThere refusal={refusal} />}
        {failure != null && <Failure error={failure} />}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={DIALOG_CANCEL_CLASS}>
            Cancel
          </button>
          <button type="button" autoFocus disabled={change.isPending} onClick={submit} data-testid="department-archive-submit" className={DIALOG_ACTION_CLASS}>
            {change.isPending ? text.pending : text.label(refusal !== null)}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function DepartmentArchiveMenu({ slug, prefix, archived }: { slug: string; prefix: string | undefined; archived: boolean }) {
  const [stage, setStage] = useState<Stage>("closed")
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-testid="department-board-menu" aria-label="Department actions" className={TRIGGER_CLASS}>
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
          <DropdownMenuItem
            className={SESSION_MENU_ITEM_CLASS}
            data-testid={archived ? "department-unarchive" : "department-archive"}
            onSelect={() => setStage(archived ? "unarchive" : "archive")}
          >
            {archived ? "Un-archive department…" : "Archive department…"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {stage !== "closed" && <ArchiveDialog key={stage} slug={slug} prefix={prefix} stage={stage} onClose={() => setStage("closed")} />}
    </>
  )
}
