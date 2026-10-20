import { useEffect, useState } from 'react'

/* The strip above the composer while messages are parked: how many, and the
 * one action that sends them all now, in order. A failed force-send says so
 * here, in the slot the count already owns. */

interface QueuedBarProps {
  count: number
  onSendAllNow: () => Promise<void>
}

export function QueuedBar({ count, onSendAllNow }: QueuedBarProps) {
  const [error, setError] = useState<string | null>(null)
  // The bar stays mounted while hidden: an old failure must not greet the next queue.
  useEffect(() => { if (count === 0) setError(null) }, [count])
  if (count === 0) return null
  return (
    <div className="flex shrink-0 items-center justify-between gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-2)]" data-queued-bar>
      <span role={error ? 'alert' : undefined} className={`text-[length:var(--text-caption1)] ${error ? 'text-[var(--system-red)]' : 'text-[var(--text-tertiary)]'}`}>
        {error ?? `${count} queued, sending after this reply in order`}
      </span>
      <button
        type="button"
        onClick={() => {
          setError(null)
          void onSendAllNow().catch(() => setError('Could not send them now, try again'))
        }}
        className="h-7 shrink-0 cursor-pointer rounded-full border-none bg-[var(--accent)] px-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--accent-contrast)]"
      >
        Send all now
      </button>
    </div>
  )
}
