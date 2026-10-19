import { Check, CircleAlert, CornerDownRight, LoaderCircle } from "@/components/ui/icon"
import type { TodoCaptureWire } from "@/lib/api"
import { CAPTURE_STEPS, landedLabel, stepLabel, type CaptureStep } from "./capture-stages"

/**
 * The live pipeline, one line per fact.
 *
 * Only steps the wire has actually reported are rendered — `steps` is the
 * accumulated truth, never the full ladder greyed out ahead of itself. Showing
 * the remaining stages dimmed would be a promise the system has not made, and
 * the whole point of deriving the stage server-side is not to make it.
 *
 * Motion is transform and opacity only, one short move per line as it lands.
 */

export function PipelineStrip({
  steps,
  state,
  error,
  settled,
}: {
  steps: CaptureStep[]
  state: TodoCaptureWire | null
  error: string | null
  settled: boolean
}) {
  const lastIndex = steps.length - 1

  return (
    <ol className="flex flex-col gap-1.5" data-testid="capture-pipeline">
      {steps.map((step, index) => {
        const isLast = index === lastIndex
        const running = isLast && !settled && !error
        return (
          <li
            key={step}
            data-testid={`capture-step-${step}`}
            data-current={isLast || undefined}
            className="flex items-center gap-2.5 text-[length:var(--text-subheadline)] motion-safe:animate-capture-step-in"
            style={{ color: isLast ? "var(--text-primary)" : "var(--text-tertiary)" }}
          >
            <StepMark running={running} />
            <span className="min-w-0 truncate">{stepLabel(step, state)}</span>
          </li>
        )
      })}

      <WaitingNote state={state} error={error} settled={settled} />
      <TerminalLine state={state} error={error} />
    </ol>
  )
}

/**
 * Why the last rung is not moving, when the gateway knows.
 *
 * A rate-limited Shaper is parked rather than broken — the gateway retries it
 * without being asked — so this is deliberately NOT the red slot below and NOT
 * a stage of its own. It is a quiet note under the spinner, because a spinner
 * that will not move for an hour with nothing said reads as a hang, and the
 * operator's next move (wait, or capture it somewhere else) depends on knowing
 * which of the two it is.
 */
function WaitingNote({ state, error, settled }: { state: TodoCaptureWire | null; error: string | null; settled: boolean }) {
  if (!state?.waitingReason || settled || error) return null
  return (
    <li
      data-testid="capture-waiting"
      className="ml-[25px] text-[length:var(--text-footnote)] motion-safe:animate-capture-step-in"
      style={{ color: "var(--text-tertiary)" }}
    >
      {/* The rate limiter's own sentence, including when it expects to resume. */}
      <span className="min-w-0 whitespace-pre-wrap break-words">{state.waitingReason}</span>
    </li>
  )
}

/**
 * The two endings that are not a rung on the ladder.
 *
 * A landing is a SUCCESS — the sentence reached the Todo that already owned it
 * — so it gets the ordinary text colour and its own mark, deliberately not the
 * red slot below it. Reading a correct dedupe as an error is the exact thing
 * this line exists to stop.
 */
function TerminalLine({ state, error }: { state: TodoCaptureWire | null; error: string | null }) {
  if (state?.stage === "landed") {
    return (
      <li
        data-testid="capture-landed"
        className="flex items-center gap-2.5 text-[length:var(--text-subheadline)] motion-safe:animate-capture-step-in"
        style={{ color: "var(--text-primary)" }}
      >
        <CornerDownRight className="size-[15px] shrink-0" style={{ color: "var(--accent)" }} aria-hidden />
        <span className="min-w-0 truncate">{landedLabel(state)}</span>
      </li>
    )
  }
  if (!error) return null
  return (
    <li
      data-testid="capture-error"
      className="flex items-start gap-2.5 text-[length:var(--text-subheadline)] motion-safe:animate-capture-step-in"
      style={{ color: "var(--system-red)" }}
    >
      <CircleAlert className="mt-[3px] size-[15px] shrink-0" aria-hidden />
      {/* The gateway's own words. Never softened, never replaced. */}
      <span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
    </li>
  )
}

function StepMark({ running }: { running: boolean }) {
  if (running) {
    return <LoaderCircle className="size-[15px] shrink-0 motion-safe:animate-spin" style={{ color: "var(--accent)" }} aria-hidden />
  }
  return <Check className="size-[15px] shrink-0" style={{ color: "var(--accent)" }} aria-hidden />
}

/** Exported for the test that pins the ladder's order to the server's. */
export const PIPELINE_STEP_ORDER = CAPTURE_STEPS
