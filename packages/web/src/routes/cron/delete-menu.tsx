import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { EllipsisVertical, MoreHorizontal, Trash2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SESSION_MENU_CONTENT_CLASS, SESSION_MENU_ITEM_CLASS } from "@/components/chat/session-row-menu"
import { api } from "@/lib/api"
import { DIALOG_CANCEL_CLASS } from "@/components/ui/dialog-actions"

/* design-cron §2 — deleting a job is the one cron action with no undo, so it
 * sits behind the same `⋯` grammar the chat sidebar already uses: always
 * visible (a hover-only control does not exist on a phone), a 44pt target on a
 * row and 34px beside the header's Run-now, and a confirm that names the job
 * before anything leaves. Disable stays the reversible
 * option one item away in the same menu's neighbourhood. */

const TRIGGER_CLASS = {
  row: "flex size-11 flex-none items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:text-[var(--text-secondary)]",
  header: "grid size-[34px] flex-none place-items-center rounded-[10px] text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]",
} as const

/** The destructive twin of `DIALOG_ACTION_CLASS`: the shared dialog geometry so
 *  the pair keeps one height, wearing the tinted-fill-and-saturated-text
 *  grammar the cron header's own Run-now already uses — in red, because this
 *  button ends the job rather than starting it. */
const DELETE_ACTION_CLASS =
  "h-[34px] rounded-full bg-[color-mix(in_srgb,var(--system-red)_16%,transparent)] px-3.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--system-red)] disabled:opacity-50"

/** The cron error style: red on an 8% tint of itself, as the detail page already
 *  reports a failed trigger. */
const DELETE_ERROR_CLASS =
  "mt-4 rounded-[var(--radius-md)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"

function DeleteConfirmDialog({ name, open, onCancel, onConfirm, pending, error }: {
  name: string
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  pending: boolean
  error: unknown
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      {/* The shared dialog defaults to a hairline, a literal black scrim and a 16px
          dismiss X — none of which belong here; Cancel is the way out, at 34px. */}
      <DialogContent
        className="max-w-[380px] border-0"
        overlayClassName="bg-[var(--scrim)]"
        showCloseButton={false}
      >
        <DialogTitle>Delete “{name}”?</DialogTitle>
        <DialogDescription>
          It stops running and leaves the list for good. Its run history is kept. To pause it instead, disable it.
        </DialogDescription>
        {error != null && (
          <div
            role="alert"
            data-testid="cron-delete-error"
            className={DELETE_ERROR_CLASS}
            style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
          >
            {error instanceof Error ? error.message : "Couldn't delete the job"}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={DIALOG_CANCEL_CLASS}>
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            disabled={pending}
            onClick={onConfirm}
            data-testid="cron-delete-confirm"
            className={DELETE_ACTION_CLASS}
          >
            {pending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Both cron routes read the list off the literal `["cron-jobs"]` key, so dropping
 *  that is what takes the row out without a reload. The dialog stays open until
 *  the refetch lands: closing on the response would flash the row back. */
function useCronDelete(id: string, onDone: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.deleteCronJob(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["cron-jobs"] })
      onDone()
    },
  })
}

/**
 * Delete one cron job, from the list row or from the detail header.
 *
 * The list row is a `role="button"` div with its own click and key handlers, and
 * React carries portalled events up the component tree rather than the DOM one —
 * so a click in the menu or the dialog, or Enter on the trigger, would otherwise
 * open the job. The wrapping span stops all three before they reach the row.
 */
export function CronDeleteMenu({ job, variant, onDeleted }: {
  job: { id: string; name: string }
  variant: "row" | "header"
  onDeleted?: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const remove = useCronDelete(job.id, () => { setConfirming(false); onDeleted?.() })
  const Glyph = variant === "row" ? EllipsisVertical : MoreHorizontal

  return (
    <span
      className="contents"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${job.name}`}
            data-testid={`cron-actions-${job.id}`}
            className={TRIGGER_CLASS[variant]}
          >
            <Glyph className="size-[18px]" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
          <DropdownMenuItem
            className={SESSION_MENU_ITEM_CLASS}
            data-testid={`cron-delete-${job.id}`}
            onClick={() => { remove.reset(); setConfirming(true) }}
            style={{ color: "var(--system-red)" }}
          >
            <Trash2 aria-hidden />
            Delete job
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteConfirmDialog
        name={job.name}
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        error={remove.error}
      />
    </span>
  )
}
