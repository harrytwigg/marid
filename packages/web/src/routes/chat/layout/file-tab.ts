/**
 * A file preview opened as a tab beside a chat. The split layout holds tabs as plain strings, so a
 * file tab is an id in its own namespace: `file:` followed by the same query the `/file` viewer
 * route takes. A session id never carries the prefix, so the two kinds cannot collide.
 */
export interface FileTabRef {
  path: string
  /** The chat that linked the path: non-root paths are read on that session's host. */
  sessionId: string | null
}

const FILE_TAB_PREFIX = 'file:'

export function isFileTabId(tabId: string): boolean {
  return tabId.startsWith(FILE_TAB_PREFIX)
}

export function fileTabId({ path, sessionId }: FileTabRef): string {
  const params = new URLSearchParams({ path })
  if (sessionId) params.set('session', sessionId)
  return `${FILE_TAB_PREFIX}${params.toString()}`
}

export function parseFileTabId(tabId: string): FileTabRef | null {
  if (!isFileTabId(tabId)) return null
  const params = new URLSearchParams(tabId.slice(FILE_TAB_PREFIX.length))
  const path = params.get('path')
  return path ? { path, sessionId: params.get('session') || null } : null
}

/** What a file tab is called in a strip: the basename. */
export function fileTabTitle(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}
