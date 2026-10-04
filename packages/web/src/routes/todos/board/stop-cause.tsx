import { useEffect, useState } from "react"
import { Pause } from "lucide-react"
import type { WorkItemCompactWire } from "@/lib/api"
import { isParked, type TodoStopCauseWire } from "@/lib/parked"
import { formatCountdown } from "../util"

/* PLA-157 — how a stopped card says why it stopped.
 *
 * Two different waits used to render identically: a Todo held by a quota window
 * and a Todo held by a person both became one tinted line under the title, and
 * that line was hidden below 700px. So the board's "N waiting" counted clocks as
 * people, and the phone showed neither.
 *
 * The countdown chip and the unblock hint separate them, and both LEAD the card
 * at every width: on a card that has stopped, the wait is the headline and the
 * title is the detail. A block whose only explanation is its transition note has
 * no line here any more — the board card is a fixed grid since ICI-1427, and the
 * note reads on the task page and in the Needs-you view instead. */

/** Whether the card carries a lead at all, from the fields alone and never from
 *  the clock: `cardLayoutKey` feeds the column's FLIP, and a key that changed on
 *  every tick would make the column re-measure once a minute forever. */
export function hasStopLead(item: WorkItemCompactWire): boolean {
  return !!item.parkedUntil || !!item.unblockHint
}

/** One bit per element, not one for the pair: a chip and a chip-plus-hint are
 *  different heights, and folding them into a single bit told the column they
 *  were the same — so the card below jumped instead of being cushioned. */
export function stopLeadKey(item: WorkItemCompactWire): string {
  return `${Number(!!item.parkedUntil)}${Number(!!item.unblockHint)}`
}

/** The park's remaining time, re-read on a timer so the chip goes away the moment
 *  it runs out rather than at the next refetch. Nothing parked installs no timer,
 *  so a board of ordinary cards costs none.
 *
 *  The wake-up is the SOONER of the next minute and the expiry itself. A fixed
 *  cadence left a park that ran out mid-interval still counting down on screen,
 *  which is the exact dishonesty this chip exists to remove. */
function useCountdown(parkedUntil: string | undefined): string {
  const [now, setNow] = useState(() => Date.now())
  const ticking = isParked(parkedUntil, now)
  useEffect(() => {
    if (!ticking || !parkedUntil) return
    const delay = Math.max(250, Math.min(30_000, Date.parse(parkedUntil) - Date.now()))
    const timer = window.setTimeout(() => setNow(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [ticking, parkedUntil, now])
  return ticking && parkedUntil ? formatCountdown(parkedUntil, now) : ""
}

/** Above the title, on desktop and on the phone: what this card is waiting for.
 *  The caller supplies its own placement, because the board card wants this
 *  hoisted out of its wrapped phone row and a list row does not. The task page's
 *  banner reads the same lead from the detail payload, so it takes only the
 *  fields it renders, and `wrapHint` lets it show a long hint whole: a card has
 *  a fixed height and the full text a click away, the task page is that click. */
export function StopCauseLead({
  item,
  className = "",
  wrapHint = false,
}: {
  item: TodoStopCauseWire & { id: string }
  className?: string
  wrapHint?: boolean
}) {
  const left = useCountdown(item.parkedUntil)
  const hint = item.unblockHint
  if (!left && !hint) return null
  const line = wrapHint ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "truncate"
  return (
    // Stacked, not side by side: the board's columns are ~200px, and a card
    // carrying both a chip and a hint had the hint's `who` clipped off its edge.
    <div
      data-testid={`stop-lead-${item.id}`}
      className={`flex min-w-0 flex-col items-start gap-1 ${className}`}
    >
      {left && (
        <span
          data-testid={`park-chip-${item.id}`}
          className="inline-flex h-5 max-w-full flex-none items-center gap-1 whitespace-nowrap rounded-[10px] px-2 text-[11px] font-medium [font-variant-numeric:tabular-nums]"
          style={{ background: "color-mix(in srgb, var(--system-orange) 18%, transparent)", color: "var(--system-orange)" }}
        >
          <Pause size={10} aria-hidden />
          Parked · {left}
        </span>
      )}
      {hint && (
        // A line each: `who` is the half that says whose move it is, and running
        // it on after `what` meant the column's width decided whether it survived.
        <span className="flex min-w-0 max-w-full flex-col text-[12px] leading-[1.35]">
          <span
            data-testid={`stop-hint-what-${item.id}`}
            className={`${line} font-medium`}
            style={{ color: "var(--system-orange)" }}
          >
            {hint.what}
          </span>
          <span data-testid={`stop-hint-who-${item.id}`} className={`${line} text-[var(--text-tertiary)]`}>{hint.who}</span>
        </span>
      )}
    </div>
  )
}
