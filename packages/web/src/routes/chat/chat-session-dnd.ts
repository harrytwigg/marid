import type { DragEvent } from 'react'

export const CHAT_SESSION_DND_MIME = 'application/x-hundredfold-chat-session'

let activeDragSessionId: string | null = null

export function hasChatSessionDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(CHAT_SESSION_DND_MIME)
}

export function writeChatSessionDrag(dataTransfer: DataTransfer, sessionId: string): void {
  activeDragSessionId = sessionId.trim() || null
  dataTransfer.setData(CHAT_SESSION_DND_MIME, sessionId)
  dataTransfer.effectAllowed = 'copy'
}

export function activeChatSessionDrag(): string | null {
  return activeDragSessionId
}

export function clearChatSessionDrag(): void {
  activeDragSessionId = null
}

export function readChatSessionDrop(dataTransfer: DataTransfer): string | null {
  if (!hasChatSessionDrag(dataTransfer)) return null
  const sessionId = dataTransfer.getData(CHAT_SESSION_DND_MIME).trim()
  return sessionId || null
}

export function isComposerDropTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-chat-composer]') !== null
}

/**
 * The drag half of a session row. Both sidebar rows wire the same pair, and a row that starts a
 * drag has to clear it too — keeping them together means neither can be added without the other.
 */
export function chatSessionDragProps(sessionId: string) {
  return {
    onDragStart: (event: DragEvent) => writeChatSessionDrag(event.dataTransfer, sessionId),
    onDragEnd: clearChatSessionDrag,
  }
}
