import type { ChatTab } from '@/hooks/use-chat-tabs'

/**
 * What the phone file view's Back does to the open-chats list: close the file tab and switch to
 * the chat it was opened from (index adjusted for the close). Null when that chat's tab is gone or
 * was never known (a file tab restored from an earlier visit): the list is left alone, since moving
 * its active tab would move the route, and Back only returns to the chat list.
 */
export function fileBackPlan(tabs: readonly ChatTab[], activeIndex: number, backId: string | null): { close: number | null; switchTo: number } | null {
  const back = backId ? tabs.findIndex((tab) => tab.kind === 'session' && tab.sessionId === backId) : -1
  if (back < 0) return null
  if (tabs[activeIndex]?.kind !== 'file') return { close: null, switchTo: back }
  return { close: activeIndex, switchTo: back > activeIndex ? back - 1 : back }
}
