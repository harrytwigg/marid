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

function ArchiveDialog({ slug, prefix, stage, onClose }: { slug: string; prefix: string | undefined; stage: Exclude<Stage, "closed">; onClose: () => void }) {
  const change = useArchiveChange(slug, onClose)
  const refusal = confirmationOf(change.error)
  const failure = change.error && !refusal ? change.error : null
  const title = departmentTitle(slug)
  const archiving = stage === "archive"
  const submit = () => change.mutate({ archived: archiving, confirm: refusal !== null })
  const label = change.isPending ? (archiving ? "Archiving…" : "Restoring…") : archiving ? (refusal ? "Archive anyway" : "Archive") : "Un-archive"

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-[400px] border-0" overlayClassName="bg-[var(--scrim)]" showCloseButton={false}>
        <DialogTitle>{archiving ? `Archive ${title}?` : `Un-archive ${title}?`}</DialogTitle>
        <DialogDescription>
          {archiving
            ? `It leaves the department lists and no new Todos can be filed in it. Its Todos keep their ${prefix ?? ""} ids and stay open, searchable and editable. You can un-archive it at any time.`
            : "It comes back to the department lists and takes new Todos again."}
        </DialogDescription>
        {refusal && <StillThere refusal={refusal} />}
        {failure != null && (
          <div role="alert" data-testid="department-archive-error" className={`${NOTICE_CLASS} text-[var(--system-red)]`} style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
            {failure instanceof Error ? failure.message : "The department could not be changed."}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={DIALOG_CANCEL_CLASS}>
            Cancel
          </button>
          <button type="button" autoFocus disabled={change.isPending} onClick={submit} data-testid="department-archive-submit" className={DIALOG_ACTION_CLASS}>
            {label}
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
