import { useState, type FormEvent } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { DIALOG_ACTION_CLASS, DIALOG_CANCEL_CLASS } from "@/components/ui/dialog-actions"
import { Input } from "@/components/ui/input"
import { AccountsError, accountsApi, describeWait, validatePassword } from "@/lib/accounts-api"

function failureText(error: unknown): string {
  if (error instanceof AccountsError && error.status === 429 && error.retryAfterSeconds) {
    return `Too many attempts. Try again in ${describeWait(error.retryAfterSeconds)}.`
  }
  return error instanceof Error ? error.message : "The password could not be changed."
}

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [again, setAgain] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const problem = validatePassword(next) ?? (next !== again ? "The two new passwords don't match." : null)
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      await accountsApi.changeMemberPassword(current, next)
      setDone(true)
    } catch (err) {
      setError(failureText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose() }}>
      <DialogContent className="max-w-[400px] border-0" overlayClassName="bg-[var(--scrim)]" showCloseButton={false}>
        <DialogTitle>Change password</DialogTitle>
        {done ? (
          <>
            <DialogDescription data-testid="password-changed">Your password is changed. Your other sessions were signed out.</DialogDescription>
            <div className="mt-4 flex justify-end"><button type="button" autoFocus onClick={onClose} className={DIALOG_ACTION_CLASS}>Done</button></div>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="mt-2 flex flex-col gap-3">
            <DialogDescription>Changing it signs out every other session of yours.</DialogDescription>
            <label className="flex flex-col gap-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              Current password
              <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </label>
            <label className="flex flex-col gap-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              New password
              <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
            </label>
            <label className="flex flex-col gap-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              New password again
              <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
            </label>
            {error && <div role="alert" className="text-[length:var(--text-footnote)] text-[var(--system-red)]">{error}</div>}
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={DIALOG_CANCEL_CLASS}>Cancel</button>
              <button type="submit" disabled={busy || !current || !next} className={DIALOG_ACTION_CLASS}>{busy ? "Saving…" : "Change password"}</button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
