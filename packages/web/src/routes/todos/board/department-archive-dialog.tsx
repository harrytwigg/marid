import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { DIALOG_ACTION_CLASS, DIALOG_CANCEL_CLASS } from "@/components/ui/dialog-actions"
import { DepartmentArchiveError, departmentApi } from "@/lib/department-api"
import { departmentTitle } from "./board-switcher"

/* The confirmation dialog behind the department board's `⋯` menu. It lives in its
 * own module so the board chunk only loads it once someone picks the action. */

const NOTICE_CLASS = "mt-4 rounded-[var(--radius-md)] p-[10px_13px] text-[length:var(--text-footnote)]"

export type ArchiveStage = "archive" | "unarchive"

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
function dialogText(stage: ArchiveStage, title: string, prefix: string | undefined) {
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

export function ArchiveDialog({ slug, prefix, stage, onClose }: { slug: string; prefix: string | undefined; stage: ArchiveStage; onClose: () => void }) {
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
