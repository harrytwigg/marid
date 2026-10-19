import { useEffect, useRef, useState } from 'react'
import { registerNoticeSink, type NoticeLevel } from '@/lib/notices'
import { cn } from '@/lib/utils'
import { registerHostNotificationSink } from '@/plugins/sdk/host-bridge'

/**
 * The one surface every notice lands on: the app's own (`raiseNotice`, which
 * `reportLoadFailure` uses) and a plugin's, whichever half raised it. The
 * browser `host.notify` and a backend one arriving as a frame both reach it
 * through the host-bridge sink.
 *
 * It registers rather than being passed down because no caller is a render:
 * they are event handlers, promise rejections and the gateway socket. Until
 * something registers, both sinks are null and every notice is dropped, which
 * is the whole reason this is mounted.
 */

/** Long enough to finish a sentence, short enough that an unattended dashboard
 *  is never left holding an hour-old notice. */
const DISMISS_AFTER_MS = 6_000

/** A plugin in a loop must not be able to paper over the app, so the stack has
 *  a ceiling and the oldest falls off it. The ceiling is per source: a flood of
 *  plugin notices pushes out older plugin notices and never an app one, so the
 *  app's own errors are not throttled by anything a plugin does. */
const MAX_VISIBLE_PER_SOURCE = 3

type Source = 'app' | 'plugin'

/** Status colour as a dot, never a painted panel — the same restraint the task
 *  page's banner uses. Info stays on the neutral text ramp: most notices are not
 *  events, and tinting them all would leave nothing for the two that are. */
const LEVEL_DOT: Record<NoticeLevel, string> = {
  info: 'var(--text-tertiary)',
  warning: 'var(--system-orange)',
  error: 'var(--system-red)',
}

interface Notice {
  id: number
  title: string
  description?: string
  level: NoticeLevel
  source: Source
}

/** The oldest of a source falls off once it has more than its share on screen. */
function capSource(notices: readonly Notice[], source: Source): readonly Notice[] {
  const mine = notices.filter((notice) => notice.source === source)
  if (mine.length <= MAX_VISIBLE_PER_SOURCE) return notices
  const dropped = new Set(mine.slice(0, mine.length - MAX_VISIBLE_PER_SOURCE))
  return notices.filter((notice) => !dropped.has(notice))
}

/** The stack and its timers, fed by both sinks for as long as it is mounted. */
function useNoticeStack() {
  const [notices, setNotices] = useState<readonly Notice[]>([])
  const nextId = useRef(0)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const pending = timers.current
    const show = (notice: Omit<Notice, 'id'>) => {
      const id = (nextId.current += 1)
      setNotices((current) => capSource([...current, { ...notice, id }], notice.source))
      // Per notice rather than one clock for the stack: a notice that arrives
      // while an older one is on screen has its own full reading time.
      const timer = setTimeout(() => {
        pending.delete(timer)
        setNotices((current) => current.filter((notice) => notice.id !== id))
      }, DISMISS_AFTER_MS)
      pending.add(timer)
    }
    const unregisterApp = registerNoticeSink((notice) => show({ ...notice, source: 'app' }))
    const unregisterPlugin = registerHostNotificationSink((notice) => show({ ...notice, source: 'plugin' }))
    return () => {
      unregisterApp()
      unregisterPlugin()
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  return [notices, setNotices] as const
}

export function Notices() {
  const [notices, setNotices] = useNoticeStack()

  if (notices.length === 0) return null

  return (
    <div
      data-notices
      className={cn(
        'pointer-events-none fixed inset-x-[var(--space-3)] z-[70] flex flex-col gap-[var(--space-2)]',
        'top-[max(var(--safe-top),var(--space-3))]',
        // From `sm` up it settles into the top-right corner at a readable
        // measure; below it, full width is the only way a sentence fits at
        // 390px without wrapping into a paragraph.
        'sm:inset-x-auto sm:right-[var(--space-4)] sm:w-[min(380px,calc(100vw-32px))]',
      )}
    >
      {notices.map((notice) => (
        <NoticeCard
          key={notice.id}
          notice={notice}
          onDismiss={() => setNotices((current) => current.filter((entry) => entry.id !== notice.id))}
        />
      ))}
    </div>
  )
}

function NoticeCard({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex items-start gap-[var(--space-3)] rounded-[var(--radius-xl)]',
        // The opaque overlay material, no blur: nothing sits behind this to read
        // as a surface, so it has to lift off the page rather than tint it, and
        // a stack of up to six cards would spend the blur budget on its own.
        'bg-[var(--material-thick-opaque)] py-[var(--space-3)] pl-[var(--space-4)] pr-[var(--space-2)]',
        'shadow-[var(--shadow-overlay)] motion-safe:animate-pop-in',
      )}
    >
      {/* Nudged down to sit on the first line's centre rather than its box:
          `items-start` aligns the two tops, and a 6px dot against footnote
          leading reads high without it. */}
      <span
        aria-hidden
        className="mt-[7px] size-1.5 shrink-0 rounded-full"
        style={{ background: LEVEL_DOT[notice.level] }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <p className="break-words text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {notice.title}
        </p>
        {notice.description && (
          <p className="break-words text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            {notice.description}
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className={cn(
          'size-[34px] shrink-0 cursor-pointer rounded-full bg-[var(--fill-tertiary)]',
          'text-[length:var(--text-subheadline)] text-[var(--text-secondary)]',
          'transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] active:scale-[0.97]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
        )}
      >
        ✕
      </button>
    </div>
  )
}
