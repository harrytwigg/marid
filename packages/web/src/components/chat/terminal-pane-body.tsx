import { lazy, Suspense, useRef, useState, type RefObject } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { CliKeybar } from '@/components/chat/cli-keybar'
import type { CliTerminalHandle } from '@/components/cli-terminal'
import { isCoarsePointer } from '@/lib/terminal-input'

const CliTerminal = lazy(() => import('@/components/cli-terminal').then((m) => ({ default: m.CliTerminal })))

/**
 * An operator terminal's pane body: the shell and nothing else.
 * There is no composer — a terminal takes no messages — so on a desktop the
 * terminal itself is the input. A touch device keeps the display-only terminal
 * (swipe to scroll), so it gets a line input and the key bar instead.
 */
export function TerminalPaneBody({ sessionId }: { sessionId: string }) {
  const terminalRef = useRef<CliTerminalHandle | null>(null)
  const [touch] = useState(() => isCoarsePointer())
  return (
    <>
      <Suspense fallback={<div style={{ flex: 1, minHeight: 0, background: 'var(--bg)' }} />}>
        <CliTerminal ref={terminalRef} sessionId={sessionId} shell />
      </Suspense>
      {touch ? <TerminalTouchInput terminalRef={terminalRef} /> : null}
    </>
  )
}

const KEY_BUTTON_CLASS = 'h-9 shrink-0 rounded-lg px-2 font-[family-name:var(--font-code)] text-footnote text-[var(--text-secondary)] active:scale-[0.96]'

function TerminalTouchInput({ terminalRef }: { terminalRef: RefObject<CliTerminalHandle | null> }) {
  const [line, setLine] = useState('')
  const send = (data: string) => terminalRef.current?.sendInput(data)
  const sendLine = () => {
    send(`${line}\r`)
    setLine('')
  }
  return (
    <div data-terminal-touch-input className="flex shrink-0 items-center gap-2 border-t border-[var(--separator)] px-3 py-2">
      <input
        value={line}
        onChange={(event) => setLine(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          sendLine()
        }}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        aria-label="Type into the terminal"
        placeholder="Type a command"
        className="min-w-0 flex-1 rounded-lg bg-[var(--fill-tertiary)] px-3 py-2 font-[family-name:var(--font-code)] text-footnote text-[var(--text-primary)] outline-none"
      />
      <button type="button" aria-label="Send to the terminal" onClick={sendLine}
        className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--accent)] text-[var(--accent-foreground)] active:scale-[0.96]">
        <CornerDownLeft className="size-4" aria-hidden />
      </button>
      <button type="button" aria-label="Send Ctrl-C" onClick={() => send('\x03')} className={KEY_BUTTON_CLASS}>^C</button>
      <CliKeybar onKey={send} />
    </div>
  )
}
