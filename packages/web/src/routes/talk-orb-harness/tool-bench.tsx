import { useState } from "react"
import { toolTimings, TOOL_BUDGET_MS, type ToolTiming } from "@/components/talk/tools/budget"
import { TALK_TARGET_ATTRIBUTE } from "@/components/talk/tools/focus-element"
import { executeToolCall } from "@/components/talk/tools/registry"
import { offerUndo } from "@/components/talk/talk-undo-store"
import type { ToolResult } from "@/components/talk/tools/tool-spec"
import { cn } from "@/lib/utils"

/**
 * The tool surface without a microphone: the calls a voice session would make,
 * on buttons, with the real measured cost of each beside them.
 *
 * The timings outlive this page — they are kept in a module ring buffer — so a
 * call that navigates away can be read back on return, which is how a real
 * browser number is captured for a navigation.
 */

const CALLS: Array<{ label: string; tool: string; args: string }> = [
  { label: "show me executing todos I started", tool: "open_todos", args: '{"board":"my","status":"executing"}' },
  { label: "open Todo 59", tool: "open_todo", args: '{"id":"59"}' },
  { label: "show the disabled jobs", tool: "open_cron", args: '{"filter":"disabled"}' },
  { label: "highlight the second row", tool: "focus_element", args: '{"target":"bench-row-2"}' },
  { label: "something we cannot do yet", tool: "jinn_action", args: '{"intent":"reorganise the board"}' },
]

/** Writes are kept apart on the bench for the same reason they are kept off the
 *  always-on tool list: a fat thumb on a read is a wasted call, and a fat thumb
 *  on a write is a write. The offer button raises a strip with a reversal that
 *  only reports itself, so the surface can be driven without a live gateway. */
const OFFERS: Array<{ label: string; performed: string; refuses?: string }> = [
  { label: "offer an undo", performed: "Commented on ABC-59." },
  { label: "offer a long undo", performed: "Labelled ABC-59: needs-review, blocked-on-design, platform." },
  // The refusal is the one state a working gateway will not show you, and it is
  // the state that has to stay readable: it carries the only account of why the
  // change is still there.
  {
    label: "offer an undo that refuses",
    performed: "Assigned ABC-59 to b-lead.",
    refuses: "Todo ABC-59 changed since it was loaded",
  },
]

function Timings({ timings }: { timings: readonly ToolTiming[] }) {
  if (timings.length === 0) {
    return <p className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">No calls yet.</p>
  }
  return (
    <ul data-testid="tool-timings" className="flex flex-col gap-[var(--space-1)]">
      {[...timings].reverse().map((timing, index) => (
        <li
          key={`${timing.tool}-${index}`}
          className="flex items-baseline justify-between gap-[var(--space-3)] text-[length:var(--text-footnote)]"
        >
          <span className="font-[var(--font-code)] text-[var(--text-secondary)]">{timing.tool}</span>
          <span
            className={cn(
              "font-[var(--font-code)] tabular-nums",
              timing.ms < TOOL_BUDGET_MS ? "text-[var(--system-green)]" : "text-[var(--system-red)]",
            )}
          >
            {timing.ms.toFixed(1)} ms
          </span>
        </li>
      ))}
    </ul>
  )
}

function CallButtons({ onRun }: { onRun: (tool: string, args: string) => void }) {
  return (
    <div className="flex flex-wrap gap-[var(--space-2)]">
      {CALLS.map((call) => (
        <button
          key={call.tool + call.label}
          onClick={() => onRun(call.tool, call.args)}
          className="h-[38px] cursor-pointer rounded-full border-none bg-[var(--fill-tertiary)] px-4 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]"
        >
          {call.label}
        </button>
      ))}
    </div>
  )
}

function UndoButtons() {
  return (
    <div className="flex flex-wrap gap-[var(--space-2)]">
      {OFFERS.map((offer) => (
        <button
          key={offer.label}
          onClick={() => offerUndo(offer.performed, async () => {
            if (offer.refuses) throw new Error(offer.refuses)
            console.log(`[talk-bench] reversed: ${offer.performed}`)
          })}
          className="h-[38px] cursor-pointer rounded-full border-none bg-[var(--fill-tertiary)] px-4 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]"
        >
          {offer.label}
        </button>
      ))}
    </div>
  )
}

function BenchRows() {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      {[1, 2, 3].map((row) => (
        <div
          key={row}
          {...{ [TALK_TARGET_ATTRIBUTE]: `bench-row-${row}` }}
          className="rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-subheadline)] text-[var(--text-secondary)]"
        >
          Row {row}
        </div>
      ))}
    </div>
  )
}

export function ToolBench() {
  // Seeded from the ring buffer, so returning to this page shows the cost of the
  // call that left it.
  const [timings, setTimings] = useState<readonly ToolTiming[]>(() => [...toolTimings()])
  const [result, setResult] = useState<ToolResult | null>(null)

  async function run(tool: string, args: string) {
    setResult(await executeToolCall(tool, args))
    // The measurement lands on the frame after the call settles.
    setTimeout(() => setTimings([...toolTimings()]), 80)
  }

  return (
    <section className="flex flex-col gap-[var(--space-3)]">
      <CallButtons onRun={(tool, args) => void run(tool, args)} />
      <UndoButtons />

      <div className="flex flex-wrap gap-[var(--space-4)]">
        <div className="min-w-[200px] flex-1">
          <Timings timings={timings} />
        </div>
        <pre
          data-testid="tool-result"
          className="min-w-[220px] flex-1 overflow-x-auto rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] p-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]"
        >
          {result ? JSON.stringify(result, null, 2) : "No result yet."}
        </pre>
      </div>

      <BenchRows />
    </section>
  )
}
