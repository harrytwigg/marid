import { useEffect, useState } from 'react'
import { ChevronDown } from '@/components/ui/icon'

const JUMP_EXIT_MS = 140

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    setReduced(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return reduced
}

/** Keeps the control mounted through its exit animation after `show` drops. */
function useExitAnimation(show: boolean, reducedMotion: boolean) {
  const [rendered, setRendered] = useState(show)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (show) {
      setRendered(true)
      setExiting(false)
      return
    }
    if (!rendered) return

    setExiting(true)
    const timer = window.setTimeout(() => {
      setRendered(false)
      setExiting(false)
    }, reducedMotion ? 1 : JUMP_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [show, reducedMotion, rendered])

  return { rendered, exiting }
}

export function JumpToLatestButton({
  show,
  unreadCount,
  onClick,
}: {
  show: boolean
  unreadCount: number
  onClick: () => void
}) {
  const reducedMotion = usePrefersReducedMotion()
  const { rendered, exiting } = useExitAnimation(show, reducedMotion)
  const hasUnread = unreadCount > 0
  const visibleUnread = unreadCount > 99 ? '99+' : String(unreadCount)
  const label = hasUnread
    ? `Jump to latest, ${unreadCount} new message${unreadCount === 1 ? '' : 's'}`
    : 'Jump to latest'

  if (!rendered) return null

  const motionClass = reducedMotion
    ? 'data-[state=exiting]:opacity-0 data-[state=visible]:opacity-100'
    : 'data-[state=exiting]:animate-[jinn-jump-out_140ms_var(--ease-snappy)_both] data-[state=visible]:animate-[jinn-jump-in_160ms_var(--ease-smooth)_both]'

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-hidden={exiting ? true : undefined}
      tabIndex={exiting ? -1 : undefined}
      data-state={exiting ? 'exiting' : 'visible'}
      className={`glass-float absolute bottom-[calc(1rem_+_var(--composer-overlap,0px))] left-1/2 z-10 inline-flex h-10 w-10 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full px-0 text-[var(--text-secondary)] transition-[transform,opacity] duration-150 ease-[var(--ease-smooth)] active:scale-[0.96] data-[state=exiting]:pointer-events-none [@media(pointer:fine)]:h-9 [@media(pointer:fine)]:w-9 ${motionClass}`}
    >
      <ChevronDown size={18} aria-hidden="true" className="-mb-px shrink-0" />
      {hasUnread && (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-[var(--weight-semibold)] leading-none text-[var(--accent-contrast)] shadow-[var(--shadow-subtle)] tabular-nums"
        >
          {visibleUnread}
        </span>
      )}
    </button>
  )
}
