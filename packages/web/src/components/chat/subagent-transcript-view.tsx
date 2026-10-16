import { useEffect, useRef } from 'react'
import { ChevronRight } from 'lucide-react'
import { toolGlyphForName } from '@/components/chat/tool-group'
import { formatMessage } from '@/components/chat/message-markdown'
import { cn } from '@/lib/utils'
import type { SubagentEntry } from '@/lib/subagent-transcript'

const QUIET = 'text-[length:var(--text-caption2)] text-[var(--text-tertiary)]'

function PromptEntry({ entry }: { entry: Extract<SubagentEntry, { kind: 'prompt' }> }) {
  return (
    <div data-testid="subagent-entry" data-kind="prompt" className="rounded-[10px] bg-[var(--fill-tertiary)] px-3 py-2">
      <div className={`mb-1 font-[var(--weight-semibold)] uppercase tracking-[0.04em] ${QUIET}`}>Prompt</div>
      <div className="whitespace-pre-wrap break-words text-[length:var(--text-footnote)] text-[var(--text-primary)]">{entry.text}</div>
    </div>
  )
}

function TextEntry({ entry }: { entry: Extract<SubagentEntry, { kind: 'text' }> }) {
  return (
    <div data-testid="subagent-entry" data-kind="text" className="break-words px-1 text-[length:var(--text-footnote)] leading-[1.5] text-[var(--text-primary)]">
      {formatMessage(entry.text)}
    </div>
  )
}

function ToolResult({ entry }: { entry: Extract<SubagentEntry, { kind: 'tool' }> }) {
  if (entry.result === null) return <div className={QUIET}>No result yet.</div>
  if (entry.result.trim() === '') return <div className={QUIET}>No output.</div>
  return (
    <pre
      data-testid="subagent-tool-result"
      className={cn(
        'm-0 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--fill-tertiary)] p-2 font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)]',
        entry.isError ? 'text-[var(--system-red)]' : 'text-[var(--text-secondary)]',
      )}
    >
      {entry.result}
    </pre>
  )
}

function ToolEntry({ entry }: { entry: Extract<SubagentEntry, { kind: 'tool' }> }) {
  const Glyph = toolGlyphForName(entry.name)
  const running = entry.result === null
  return (
    <details
      data-testid="subagent-entry"
      data-kind="tool"
      data-state={running ? 'running' : entry.isError ? 'error' : 'done'}
      className="group rounded-[10px] border border-[var(--separator)] px-2.5 py-1.5"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 text-[length:var(--text-caption1)] text-[var(--text-secondary)] [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
        <Glyph size={13} aria-hidden="true" className="shrink-0" />
        <span className="shrink-0 font-[var(--weight-medium)] text-[var(--text-primary)]">{entry.name}</span>
        <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)]">{entry.input}</span>
        <span
          className={cn('shrink-0', QUIET, entry.isError && 'text-[var(--system-red)]')}
        >
          {running ? 'running…' : entry.isError ? 'failed' : null}
        </span>
      </summary>
      <div className="mt-1.5 space-y-1.5">
        {entry.input ? (
          <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] text-[var(--text-secondary)]">{entry.input}</pre>
        ) : null}
        <ToolResult entry={entry} />
      </div>
    </details>
  )
}

/**
 * A sub-agent's conversation as a read-only list: what it was asked, what it said, and each tool
 * call with its result folded under it. Follows the end while the reader is at it, and leaves the
 * reader where they are once they scroll up.
 */
export function SubagentTranscriptView({ entries, truncated }: { entries: SubagentEntry[]; truncated: boolean }) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const node = scroller.current
    if (node && pinned.current) node.scrollTop = node.scrollHeight
  }, [entries])

  return (
    <div
      ref={scroller}
      data-testid="subagent-transcript"
      onScroll={(event) => {
        const node = event.currentTarget
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
      }}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3"
    >
      {truncated ? <p className={`m-0 text-center ${QUIET}`}>Earlier messages are not shown.</p> : null}
      {entries.length === 0 ? <p className={`m-0 py-6 text-center text-[length:var(--text-caption1)] text-[var(--text-secondary)]`}>Nothing yet.</p> : null}
      {entries.map((entry, index) => {
        if (entry.kind === 'prompt') return <PromptEntry key={index} entry={entry} />
        if (entry.kind === 'text') return <TextEntry key={index} entry={entry} />
        return <ToolEntry key={entry.id} entry={entry} />
      })}
    </div>
  )
}
