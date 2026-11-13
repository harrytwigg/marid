import { useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { DIALOG_ACTION_CLASS, DIALOG_CANCEL_CLASS } from "@/components/ui/dialog-actions"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { operatorSafeTodoError } from "@/lib/todos"

interface MemberNewTodoDialogProps {
  department: string
  /** Files the Todo under this one: a sub-board's "+ New". */
  parentId?: string
  onClose: () => void
  onCreated: () => void
}

/** A member's new Todo: a title and an optional description, filed on the board they are looking at.
 *  Nothing here assigns, schedules or starts anyone: the Todo lands unassigned in To do. */
export function MemberNewTodoDialog({ department, parentId, onClose, onCreated }: MemberNewTodoDialogProps) {
  const qc = useQueryClient()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = title.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.createWorkItem({ title: text, department, ...(parentId ? { parentId } : {}), ...(body.trim() ? { body: body.trim() } : {}) })
      await qc.invalidateQueries({ queryKey: ["work-items"] })
      onCreated()
    } catch (caught) {
      setBusy(false)
      setError(operatorSafeTodoError(caught, caught instanceof Error ? caught.message : "Couldn't create the Todo"))
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-[460px] border-0" overlayClassName="bg-[var(--scrim)]" showCloseButton={false}>
        <DialogTitle>New Todo</DialogTitle>
        <form onSubmit={(event) => void submit(event)} className="mt-2 flex flex-col gap-3" data-testid="member-new-todo">
          <Input autoFocus aria-label="Title" placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
          <Textarea aria-label="Description" placeholder="Details (optional)" value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
          {error && <div role="alert" className="text-[length:var(--text-footnote)] text-[var(--system-red)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={DIALOG_CANCEL_CLASS}>Cancel</button>
            <button type="submit" disabled={busy || !title.trim()} data-testid="member-new-todo-create" className={DIALOG_ACTION_CLASS}>
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
