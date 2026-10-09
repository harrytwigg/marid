import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { HoverCard } from 'radix-ui'
import { isTodoId, todoPath } from '@/lib/todo-id'
import { requestTodoPreview, useTodoPreview } from '@/lib/todo-preview'
import { useKnownTodoPrefixes } from '@/components/chat/todo-prefix-context'
import { useOpenTodo } from '@/components/chat/file-open-context'
import { useFileLinkSession } from '@/components/chat/file-link-session-context'
import { useHoverGlanceEnabled } from '@/hooks/use-hover-glance'
import { TodoGlance } from '@/components/todo-glance'

/** Long enough that sweeping a sentence full of mentions opens none of them,
 *  short enough that resting on one reads as instant. */
const OPEN_DELAY_MS = 120
/** The grace window: long enough for the cursor to cross the 6px gap onto the
 *  strip, short enough that a neighbouring mention's strip never opens before
 *  this one has gone — which is what would read as flicker. */
const CLOSE_DELAY_MS = 80
/** Followed to the full page, a phone's back chevron returns to the mention rather than to a board. */
const MENTION_ROUTE_STATE = { returnBack: true }

/** A click the browser is meant to keep: a new tab, a new window, a download,
 *  or the middle button. The Todo tab lives inside one browser tab, so these
 *  always stay navigation. */
function isBrowserNavigation(event: React.MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

/** The one anchor every surface uses to render a Todo id as a reference to that
 *  Todo. Rendering the id also warms its preview, so the hover glance built on
 *  top of this has the row already in hand instead of opening a request. Hovering
 *  reads the Todo on a strip; a plain left click opens it as a tab beside the
 *  chat it was clicked in where the chat layout can take one; everywhere else —
 *  and for every modified click — the anchor navigates to the full page. An id whose prefix belongs to no live company
 *  board is not a mention: it stays the caller's fallback (or plain text) and
 *  asks the gateway nothing. */
export function TodoMention({ id, fallback }: { id: string; fallback?: React.ReactNode }) {
  const knownPrefixes = useKnownTodoPrefixes()
  const isLive = isTodoId(id) && knownPrefixes.has(id.slice(0, 3))

  useEffect(() => {
    if (!isLive) return
    // The anchor never reads the preview, so a failed warm costs it nothing —
    // whoever reads the cache surfaces the failure, and the id is forgotten so
    // that read retries. Swallowing here only keeps it off the console.
    requestTodoPreview(id).catch(() => {})
  }, [id, isLive])

  if (!isLive) return fallback ?? id
  return <LiveTodoMention id={id} />
}

/** What a plain left click on a live mention does: open the Todo as a tab beside the chat it was
 *  clicked in where the chat layout can take one; a modified click, or a surface without the layout,
 *  stays navigation to the full page. Also whether the hover strip may open, which it may not while
 *  the Todo is already on screen because of this mention. */
function useMentionOpen(id: string) {
  const openTodo = useOpenTodo()
  const sessionId = useFileLinkSession()
  const [glanceOpen, setGlanceOpen] = useState(false)
  // Opened as a tab, the Todo is on screen beside the mention, so the strip has nothing left to say
  // about it until the cursor next comes back to the mention. Merely closing the strip on click is
  // not enough: the click leaves the cursor on the mention, so the trigger stays engaged and asks to
  // open again the moment its delay elapses.
  const [openedHere, setOpenedHere] = useState(false)

  const onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (isBrowserNavigation(event)) return
    if (openTodo?.(id, sessionId)) {
      event.preventDefault()
      // The pane the mention sits in would take focus back on this click's way up, from the Todo's
      // tab where it is open in another pane.
      event.stopPropagation()
      setGlanceOpen(false)
      setOpenedHere(true)
    }
  }

  return {
    onClick,
    glanceOpen: glanceOpen && !openedHere,
    setGlanceOpen,
    onPointerEnter: () => setOpenedHere(false),
  }
}

/** The anchor itself, and the two affordances layered on it: the strip that
 *  reads the Todo on hover, and the click that opens it in a tab.
 *  Mounted only for an id that names a live Todo, so a plain word never pays for
 *  either. */
function LiveTodoMention({ id }: { id: string }) {
  const glanceEnabled = useHoverGlanceEnabled()
  const mention = useMentionOpen(id)

  const link = (
    <Link
      to={todoPath(id)}
      state={MENTION_ROUTE_STATE}
      title={`Open ${id}`}
      onClick={mention.onClick}
      className="text-[var(--system-blue)] underline decoration-[var(--system-blue)]/40 hover:decoration-[var(--system-blue)] underline-offset-2 font-[family-name:var(--font-code)] text-[0.88em]"
    >
      {id}
    </Link>
  )

  if (!glanceEnabled) return link
  return (
    <HoverCard.Root
      open={mention.glanceOpen}
      onOpenChange={mention.setGlanceOpen}
      openDelay={OPEN_DELAY_MS}
      closeDelay={CLOSE_DELAY_MS}
    >
      <HoverCard.Trigger asChild onPointerEnter={mention.onPointerEnter}>{link}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="start"
          sideOffset={6}
          alignOffset={-8}
          collisionPadding={8}
          className="todo-glance z-50"
        >
          <MentionGlance id={id} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}

/** Mounted only while the glance is open, so a mention nobody hovers subscribes
 *  to nothing. Until the preview resolves there is nothing honest to say about
 *  the Todo, so the strip stays undrawn rather than flashing an empty pill. */
function MentionGlance({ id }: { id: string }) {
  const { data } = useTodoPreview(id)
  if (!data) return null
  return <TodoGlance id={id} title={data.workItem.title} status={data.workItem.status} />
}
