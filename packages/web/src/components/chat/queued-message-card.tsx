import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ArrowUp, Pencil, X } from '@/components/ui/icon'
import { type MediaAttachment } from '@/lib/conversations'
import { MessageMedia } from './message-media'
import { SessionQueueContext, type QueuedMessage } from './use-session-queue'

/* A message the operator has sent that is still waiting its turn. It sits where
 * its bubble would sit, on a neutral raised plate rather than the amber fill a
 * delivered message gets — parked, not sent. Three actions and no fourth: edit
 * it, drop it, or jump it to the front of the queue. */

const ORDINAL_SUFFIXES = ['th', 'st', 'nd', 'rd'] as const

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st. */
function ordinal(position: number): string {
  const tens = position % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ORDINAL_SUFFIXES[position % 10] ?? 'th'
  return `${position}${suffix}`
}

export function queueCaption(position: number, editing: boolean): string {
  if (editing) return 'Editing · Return to save'
  return position === 1 ? 'Sends after this reply' : `${ordinal(position)} in queue`
}

interface CardActionProps {
  label: string
  onClick: () => void
  active?: boolean
  hero?: boolean
  children: React.ReactNode
}

/* 34px square: the tap target the mobile layout needs, whatever the glyph
 * inside it weighs. Ghost actions carry no fill until they are pointed at. */
function CardAction({ label, onClick, active, hero, children }: CardActionProps) {
  const tone = hero
    ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
    : active
      ? 'bg-[var(--fill-primary)] text-[var(--text-primary)]'
      : 'text-[var(--text-tertiary)] hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-primary)]'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-full border-none transition-colors duration-[var(--duration-fast)] ${tone}`}
    >
      {children}
    </button>
  )
}

interface CardFooterProps {
  position: number
  editing: boolean
  error: string | null
  onEdit: () => void
  onCancel: () => void
  onSendNow: () => void
}

function CardFooter({ position, editing, error, onEdit, onCancel, onSendNow }: CardFooterProps) {
  return (
    <div className="mt-[var(--space-2)] flex items-center justify-between gap-[var(--space-2)]">
      <span
        role={error ? 'alert' : undefined}
        className={`text-[length:var(--text-caption1)] ${error ? 'text-[var(--system-red)]' : 'text-[var(--text-tertiary)]'}`}
      >
        {error ?? queueCaption(position, editing)}
      </span>
      <div className="flex items-center gap-[var(--space-1)]">
        <CardAction label={editing ? 'Save this message' : 'Edit this message'} active={editing} onClick={onEdit}>
          <Pencil size={15} />
        </CardAction>
        <CardAction label="Cancel this message" onClick={onCancel}>
          <X size={16} />
        </CardAction>
        <CardAction label="Send this message now" hero onClick={onSendNow}>
          <ArrowUp size={16} />
        </CardAction>
      </div>
    </div>
  )
}

interface CardEditorProps {
  draft: string
  onChange: (next: string) => void
  onSave: () => void
  onCancel: () => void
}

/* Edits in place, on the card, with the caret where the operator left off.
 * Grows with the text so a long message is never edited through a peephole. */
function CardEditor({ draft, onChange, onSave, onCancel }: CardEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const field = ref.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }, [draft])
  useEffect(() => {
    ref.current?.focus()
    ref.current?.setSelectionRange(ref.current.value.length, ref.current.value.length)
  }, [])
  return (
    <textarea
      ref={ref}
      value={draft}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') return onCancel()
        if (event.key !== 'Enter' || event.shiftKey) return
        event.preventDefault()
        onSave()
      }}
      rows={1}
      className="block w-full resize-none border-none bg-transparent p-0 text-[length:var(--text-body)] text-[var(--text-primary)] outline-none"
    />
  )
}

interface QueuedMessageCardProps {
  queued: QueuedMessage
  media?: MediaAttachment[]
}

/** Why an action did not happen, in the caption slot the card already has. */
function failureText(error: unknown, verb: string): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Could not ${verb} · ${detail} · try again`
}

/** The card's own state: what is being typed, and why the last action failed. */
function useCardActions(itemId: string, text: string) {
  const queue = useContext(SessionQueueContext)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (verb: string, action: Promise<void>) => {
    setError(null)
    try {
      await action
      return true
    } catch (failure) {
      setError(failureText(failure, verb))
      return false
    }
  }, [])

  const save = useCallback(async () => {
    const next = draft?.trim()
    if (!next || next === text) return setDraft(null)
    // The draft stays put until the server has taken it: closing the editor on a
    // rejected PATCH would throw away what the operator typed.
    if (await run('save that edit', queue.edit(itemId, next))) setDraft(null)
  }, [draft, text, run, queue, itemId])

  return { queue, draft, setDraft, error, run, save }
}

export function QueuedMessageCard({ queued, media }: QueuedMessageCardProps) {
  // The parked row is what runs and what a queue refresh re-reads, so it is also
  // what the card shows. The transcript row is not refetched after an edit.
  const text = queued.item.prompt
  const { queue, draft, setDraft, error, run, save } = useCardActions(queued.item.id, text)
  const editing = draft !== null

  // The transcript's shared turn spacer gives consecutive operator turns 4px, which
  // is right for plain bubbles and too tight for two raised plates. The card pays
  // for its own separation here rather than teaching the spacer about the queue,
  // and pays a step more at the head so the block reads apart from the reply above.
  return (
    <div className={`flex flex-col items-end px-[var(--space-3)] lg:px-[var(--space-8)] ${
      queued.position === 1 ? 'pt-[var(--space-4)]' : 'pt-[var(--space-3)]'
    }`}>
      <div
        data-queued-message
        data-editing={editing || undefined}
        className={`w-full max-w-[34rem] rounded-[var(--radius-lg)] bg-[var(--bg-tertiary)] px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-2)] ${
          editing ? 'shadow-[0_0_0_2px_var(--talk-focus-ring)]' : 'shadow-[var(--shadow-subtle)]'
        }`}
      >
        {editing ? (
          <CardEditor draft={draft} onChange={setDraft} onSave={() => void save()} onCancel={() => setDraft(null)} />
        ) : (
          text && <div className="whitespace-pre-wrap text-[length:var(--text-body)] text-[var(--text-primary)]">{text}</div>
        )}
        {media && media.length > 0 && <MessageMedia media={media} isUser={true} />}
        <CardFooter
          position={queued.position}
          editing={editing}
          error={error}
          onEdit={() => (editing ? void save() : setDraft(text))}
          onCancel={() => void run('cancel that message', queue.cancel(queued.item.id))}
          onSendNow={() => void run('send that message now', queue.sendNow(queued.item.id))}
        />
      </div>
    </div>
  )
}
