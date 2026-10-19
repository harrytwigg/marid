import { useRef, type CSSProperties } from 'react'
import { ChevronDown, FileText, Globe, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react'
import type { Message } from '@/lib/conversations'
import type { SubagentRef } from '@/lib/subagent-transcript'
import { statusMark } from './chat-blocks'
import { commsArrivalDelayMs } from './message-arrival'
import { usePersistentExpansion } from './transcript-expansion'
import { cn } from '@/lib/utils'

// A finished tool call lands in the transcript as "Used <tool>". While it's
// still running the content carries the live tool name instead.
export function isToolDone(msg: Message): boolean {
  return msg.content.startsWith('Used ')
}

function findActiveToolIndex(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!isToolDone(msgs[i])) return i
  }
  return -1
}

const TOOL_GLYPH_RULES: ReadonlyArray<{
  glyph: LucideIcon
  matches: readonly string[]
}> = [
  { glyph: FileText, matches: ['read', 'write', 'edit', 'file', 'patch', 'notebook'] },
  { glyph: Terminal, matches: ['bash', 'shell', 'exec', 'run', 'command'] },
  { glyph: Search, matches: ['grep', 'glob', 'search', 'find'] },
  { glyph: Globe, matches: ['fetch', 'web', 'browser', 'http'] },
]

export function toolGlyphForName(toolName: string): LucideIcon {
  const normalized = toolName.replace(/^mcp__.*?__/i, '').toLowerCase()
  return TOOL_GLYPH_RULES.find(({ matches }) => matches.some((match) => normalized.includes(match)))?.glyph
    ?? Wrench
}

/** The stagger this arrival sits at, as the shared `--arrive-delay` rail reads
 *  it. Absent when the row carries no index, so the CSS fallback applies. */
function arriveDelay(arrival: number | undefined): CSSProperties | undefined {
  if (arrival === undefined) return undefined
  return { '--arrive-delay': `${commsArrivalDelayMs(arrival)}ms` } as CSSProperties
}

interface ToolEntry {
  msg: Message
  index: number
}

/** Opens a background sub-agent's transcript from its Agent card. `returnFocusTo`
 *  is the card, which is still on the page when the view closes. Not
 *  `file-open-context`'s `OpenSubagent`, which opens a tab and answers whether one opened. */
export type OpenSubagentCard = (agent: SubagentRef, returnFocusTo: HTMLElement | null) => void

/** The sub-agent id a background `Agent`/`Task` launch left on its row, if any. */
function subagentIdOf(msg: Message): string | null {
  const id = msg.meta?.agentId
  return typeof id === 'string' && id ? id : null
}

/** Stable across the group's re-renders, including the calls that carry no id. */
function toolChipKey(entry: ToolEntry): string {
  return entry.msg.id || `${entry.msg.toolCall}-${entry.index}`
}

/** Which rail a chip entered on: the live arrival rail, or the reader opening a
 *  group that had already settled. */
type ChipEnter = 'chip' | 'expand'

/** The first ten, plus the running one when it sits deeper than that — a long
 *  pile still has to show what it is doing right now. */
function visibleToolEntries(msgs: Message[], activeIndex: number, showAll: boolean): ToolEntry[] {
  const indexed = msgs.map((msg, index) => ({ msg, index }))
  if (showAll) return indexed
  if (activeIndex >= 10) return [...indexed.slice(0, 9), indexed[activeIndex]]
  return indexed.slice(0, 10)
}

const CHIP_BASE = 'inline-flex min-h-9 max-w-full items-center gap-1.5 px-2.5 py-1 text-left'

function ToolChipContent({ msg, index, status }: { msg: Message; index: number; status: 'done' | 'running' | 'queued' }) {
  const ToolGlyph = toolGlyphForName(msg.toolCall || '')
  return (
    <>
      <span className="grid size-4 shrink-0 place-items-center">
        {statusMark(status)}
      </span>
      <ToolGlyph size={13} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
      <span className="min-w-0 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
        {msg.toolCall || `Tool ${index + 1}`}
      </span>
    </>
  )
}

function ToolChip({ entry, activeIndex, arrival, enter, onOpenSubagent }: {
  entry: ToolEntry
  activeIndex: number
  arrival: number | undefined
  enter: ChipEnter | undefined
  onOpenSubagent?: OpenSubagentCard
}) {
  const { msg, index } = entry
  const status = isToolDone(msg) ? 'done' : index === activeIndex ? 'running' : 'queued'
  const agentId = subagentIdOf(msg)
  const className = cn(CHIP_BASE, enter && 'tool-arrive')
  const style = enter ? arriveDelay(arrival) : undefined
  // Only a background sub-agent launch carries an agent id: its card opens the same
  // read-only transcript the waiting-on popup does, which is gone once it finishes.
  // The card keeps no description or agent type, so the view opens without the row's labels.
  if (agentId && onOpenSubagent) {
    return (
      <button
        type="button"
        data-tool-enter={enter}
        data-pane-focus-preserving
        style={style}
        className={cn(className, 'cursor-pointer rounded-md border-none bg-transparent font-[inherit] transition-colors duration-150 hover:bg-[var(--fill-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]')}
        aria-label={`Open the ${msg.toolCall || 'Agent'} sub-agent transcript`}
        onClick={(event) => onOpenSubagent({ id: agentId, description: null, agentType: null }, event.currentTarget)}
      >
        <ToolChipContent msg={msg} index={index} status={status} />
      </button>
    )
  }
  return (
    <div data-tool-enter={enter} style={style} className={className}>
      <ToolChipContent msg={msg} index={index} status={status} />
    </div>
  )
}

/** The chips the reader's own expansion animates in: the ones the group held
 *  when it opened. Latched at mount, so an already-open group cannot restart the
 *  stagger, and a call appended into one rides the live arrival rail instead. */
function useExpandedChips(entries: ToolEntry[], expanding: boolean): ReadonlySet<string> {
  const opened = useRef<ReadonlySet<string> | null>(null)
  if (!opened.current) opened.current = new Set(expanding ? entries.map(toolChipKey) : [])
  return opened.current
}

function ToolChipList({ msgs, activeIndex, showAll, onShowAll, arrivals, isEntering, expanding, onOpenSubagent }: {
  msgs: Message[]
  activeIndex: number
  showAll: boolean
  onShowAll: () => void
  arrivals: Map<string, number>
  isEntering: (id: string | undefined) => boolean
  /** The reader just opened this group. False when the list comes back with a
   *  windowed row that was already open — that is not an entrance. */
  expanding: boolean
  onOpenSubagent?: OpenSubagentCard
}) {
  const entries = visibleToolEntries(msgs, activeIndex, showAll)
  const expandedChips = useExpandedChips(entries, expanding)
  const hiddenToolCount = Math.max(0, msgs.length - entries.length)
  return (
    <div
      className="mt-1.5 flex max-w-[min(620px,calc(100vw_-_var(--space-6)))] flex-col items-start gap-1 pl-1"
      data-testid="tool-group-list"
    >
      {entries.map((entry, position) => {
        const live = isEntering(entry.msg.id)
        return (
          <ToolChip
            key={toolChipKey(entry)}
            entry={entry}
            activeIndex={activeIndex}
            // A live call keeps the slot the arrival rail gave it; a chip the
            // reader just revealed staggers by its place in the opened list.
            arrival={live ? arrivals.get(entry.msg.id ?? '') : position}
            enter={live ? 'chip' : expandedChips.has(toolChipKey(entry)) ? 'expand' : undefined}
            onOpenSubagent={onOpenSubagent}
          />
        )
      })}
      {hiddenToolCount > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className="ml-6 inline-flex min-h-8 items-center gap-1 rounded-full border-none bg-transparent px-2.5 text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-[background-color,color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)] active:scale-[0.96]"
        >
          Show {hiddenToolCount} more
          <ChevronDown size={13} className="shrink-0 text-[var(--text-quaternary)]" />
        </button>
      )}
    </div>
  )
}

function ToolGroupPill({ count, running, expanded, onToggle, entering, arrival }: {
  count: number
  running: boolean
  expanded: boolean
  onToggle: () => void
  entering: boolean
  arrival: number | undefined
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      data-tool-enter={entering ? 'group' : undefined}
      style={entering ? arriveDelay(arrival) : undefined}
      className={cn(
        'inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border-none bg-[var(--fill-quaternary)] py-1 pl-3 pr-2.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)] shadow-none transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.97]',
        entering && 'tool-arrive',
      )}
    >
      <Wrench size={13} className="shrink-0 text-[var(--text-tertiary)]" />
      <span className="min-w-0 truncate font-[var(--weight-medium)]">
        {`${count} tool${count !== 1 ? 's' : ''}${running ? ' running…' : ''}`}
      </span>
      {running && (
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--system-blue)] animate-[jinn-pulse_1.4s_infinite]" />
      )}
      <ChevronDown size={14} className={`ml-0.5 shrink-0 text-[var(--text-quaternary)] transition-transform duration-150 ease-[var(--ease-smooth)] ${expanded ? 'rotate-180' : 'rotate-0'}`} />
    </button>
  )
}

/**
 * The call whose rail slot the group's pill enters on, or undefined when the
 * group was already on screen.
 *
 * The pill is the group's own arrival, so the question is only ever asked once,
 * at mount: a call appended into a group the reader is already looking at must
 * not re-animate the pill above it. Which call answers it is not necessarily the
 * first — a group that opens with more calls than the rail's three slots leaves
 * its opener unmarked, and anchoring on the opener alone would drop the
 * entrance of the whole group.
 */
function useGroupArrival(msgs: Message[], isEntering: (id: string | undefined) => boolean): string | undefined {
  const latched = useRef<{ id: string | undefined } | null>(null)
  if (!latched.current) {
    latched.current = { id: msgs.find((msg) => isEntering(msg.id))?.id }
  }
  return latched.current.id
}

export function ToolGroup({ msgs, isActive, groupId, arrivals, isEntering, onOpenSubagent }: {
  msgs: Message[]
  isActive: boolean
  /** Identity the expansion outlives the row by, once virtualised. */
  groupId: string
  /** Stagger index per live-arrived tool call — the same rail comms rows use. */
  arrivals: Map<string, number>
  /** True while a tool call that arrived live still owes its entrance. */
  isEntering: (id: string | undefined) => boolean
  /** Opens a finished background sub-agent's transcript from its Agent card. */
  onOpenSubagent?: OpenSubagentCard
}) {
  const [expanded, setExpanded] = usePersistentExpansion(`tools:${groupId}`, false)
  const [showAllTools, setShowAllTools] = usePersistentExpansion(`tools-all:${groupId}`, false)
  const arrivingId = useGroupArrival(msgs, isEntering)
  // Whether the reader opened the group here. The expansion outlives the row, so
  // a windowed row scrolling back into view restores an open group without
  // re-opening it, and an entrance it already played must not play again.
  const openedHere = useRef(false)

  return (
    // Share the assistant text gutter (.assistant-msg-row → space-3 / space-8 @lg)
    // so the tool card's left edge lines up with the message text column.
    <div className="assistant-msg-row mb-[var(--space-1)]">
      <ToolGroupPill
        count={msgs.length}
        running={isActive && !msgs.every(isToolDone)}
        expanded={expanded}
        onToggle={() => {
          openedHere.current = !expanded
          setExpanded(!expanded)
        }}
        entering={arrivingId !== undefined}
        arrival={arrivals.get(arrivingId ?? '')}
      />
      {expanded && (
        <ToolChipList
          msgs={msgs}
          activeIndex={isActive ? findActiveToolIndex(msgs) : -1}
          showAll={showAllTools}
          onShowAll={() => setShowAllTools(true)}
          arrivals={arrivals}
          isEntering={isEntering}
          expanding={openedHere.current}
          onOpenSubagent={onOpenSubagent}
        />
      )}
    </div>
  )
}
