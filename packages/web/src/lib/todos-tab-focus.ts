/**
 * Whether the chat page is showing the Todos tab right now, for what lives outside the page and has to
 * know what the reader is looking at (the voice assistant's snapshot): the route is "/" for a chat and for
 * the tab alike, so the address cannot say. The chat page writes it, and clears it when it goes.
 */

let focused = false
const listeners = new Set<() => void>()

export function setTodosTabFocused(next: boolean): void {
  if (focused === next) return
  focused = next
  listeners.forEach((listener) => listener())
}

export function getTodosTabFocused(): boolean {
  return focused
}

export function subscribeTodosTabFocused(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
