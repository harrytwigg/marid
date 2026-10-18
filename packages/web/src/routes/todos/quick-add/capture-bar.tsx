import { useState } from "react"
import { ArrowUp, Check } from "lucide-react"
import { TodoDialog } from "../todo-dialog"
import { CaptureMic } from "./capture-mic"
import { PipelineStrip } from "./pipeline-strip"
import { useTodoCapture } from "./use-todo-capture"

/**
 * Quick capture: one field, one send, nothing else.
 *
 * This is a capture surface, not a form — the whole reason it exists beside the
 * `+` is that the full form asks for decisions the operator does not have yet.
 * Everything the Todo needs (title, body, department, priority) is the Shaper's
 * job to work out, so nothing here asks for any of it.
 *
 * Submitting posts immediately and never asks again. That is the autonomy
 * contract for typed capture: the operator has already read what they typed.
 */

const SHELL = "inset-x-3 bottom-3 rounded-[var(--radius-xl)] px-4 py-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:left-1/2 sm:top-[18%] sm:bottom-auto sm:w-[min(560px,calc(100vw-32px))] sm:-translate-x-1/2 sm:px-5 sm:py-[18px]"

function CaptureField({
  text,
  onChange,
  onSubmit,
  onTranscript,
  locked,
  confirming,
}: {
  text: string
  onChange: (value: string) => void
  onSubmit: () => void
  onTranscript: (value: string) => void
  locked: boolean
  confirming: boolean
}) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        autoFocus
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return
          event.preventDefault()
          onSubmit()
        }}
        disabled={locked}
        aria-label="Capture"
        data-testid="quick-capture-input"
        placeholder="What's on your mind?"
        className="min-w-0 flex-1 bg-transparent text-[length:var(--text-body)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] disabled:opacity-60"
      />
      {!locked && <CaptureMic onTranscript={onTranscript} />}
      <button
        type="button"
        onClick={onSubmit}
        disabled={!text.trim() || locked}
        aria-label={confirming ? "Send dictated capture" : "Send capture"}
        data-testid="quick-capture-send"
        data-confirming={confirming || undefined}
        className="focus-outline inline-flex size-[34px] shrink-0 items-center justify-center rounded-full bg-[var(--accent-fill)] text-[var(--accent)] shadow-[var(--inset-shine)] outline-none transition-transform hover:scale-[0.96] disabled:opacity-40 motion-reduce:transition-none"
      >
        {confirming ? <Check className="size-4" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}
      </button>
    </div>
  )
}

/** The one thing this surface ever asks the operator, and why it asks it. */
function ConfirmHint() {
  return (
    <p className="mt-2 text-[length:var(--text-footnote)] text-[var(--text-tertiary)]" data-testid="quick-capture-confirm-hint">
      Edit if it misheard you, then send.
    </p>
  )
}

/**
 * The bar's own state, and the one asymmetry in it.
 *
 * A landed transcript sets `confirming` and NOTHING is posted. The typed path
 * has no such state and posts straight through. That is deliberate: the
 * operator has already read what they typed, but has only *heard* what they
 * said — and a misheard sentence would spawn a real session doing real work on
 * the wrong thing. One tap is the cheapest guard against that, and it is the
 * only place in this surface where the operator is asked anything.
 */
function useCaptureDraft() {
  const [text, setText] = useState("")
  const [confirming, setConfirming] = useState(false)
  const { run, start } = useTodoCapture()
  const started = run.steps.length > 0

  function submit() {
    const value = text.trim()
    if (!value || started) return
    const speechDerived = confirming
    setConfirming(false)
    void start(value, speechDerived)
  }

  function change(value: string) {
    setText(value)
    if (!value.trim()) setConfirming(false)
  }

  function landTranscript(transcript: string) {
    setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript))
    setConfirming(true)
  }

  return { text, confirming, run, started, submit, change, landTranscript }
}

export function QuickCaptureBar({ onClose }: { onClose: () => void }) {
  const [leaving, setLeaving] = useState(false)
  const { text, confirming, run, started, submit, change, landTranscript } = useCaptureDraft()

  return (
    <TodoDialog
      open={!leaving}
      label="Quick capture"
      testId="quick-capture"
      onRequestClose={() => setLeaving(true)}
      onClosed={onClose}
      className={SHELL}
    >
      <CaptureField
        text={text}
        onChange={change}
        onSubmit={submit}
        onTranscript={landTranscript}
        locked={started}
        confirming={confirming}
      />

      {confirming && !started && <ConfirmHint />}

      {started && (
        <div className="mt-3.5 border-t border-[var(--separator)] pt-3.5">
          <PipelineStrip steps={run.steps} state={run.state} error={run.error} settled={run.settled} />
        </div>
      )}
    </TodoDialog>
  )
}
