import React from 'react'
import { buildFileReadRequest } from '@/lib/file-read-request'
import { useFileLinkSession } from '@/components/chat/file-link-session-context'

// Bare paths stay deliberately narrow: optional ~/ or / prefix, ≥1
// slash-separated segment, and a short extension. Backticked paths may use the
// viewer's supported roots and broader filename characters; the backticks give
// that form an unambiguous boundary without making ordinary prose linkable.
export const FILE_PATH_CORE = String.raw`(?:~\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,8}`
const FILE_PATH_RE = new RegExp(`^${FILE_PATH_CORE}$`)
const SUPPORTED_VIEWER_ROOT_RE = /^(?:knowledge|docs|files|uploads)\//

/** The `/file` viewer URL for a chat path, or null when it cannot be opened.
 *  With a session, every path is read where that session runs (a remote
 *  agent's `docs/x.md` is its repo's, not the instance's). Without one, only
 *  instance-root paths can be opened, so anything else stays plain text. */
function buildChatFileLink(path: string, sessionId: string | null): { trimmed: string; href: string } | null {
  const trimmed = path.trim()
  if (!isFilePath(trimmed)) return null
  const href = `/file?path=${encodeURIComponent(trimmed)}`
  if (sessionId) return { trimmed, href: `${href}&session=${encodeURIComponent(sessionId)}` }
  return SUPPORTED_VIEWER_ROOT_RE.test(trimmed) ? { trimmed, href } : null
}

/** Whether `s` is shaped like a linkable file path (session-independent). */
export function isFilePath(s: string): boolean {
  const trimmed = s.trim()
  return SUPPORTED_VIEWER_ROOT_RE.test(trimmed) ? buildFileReadRequest(trimmed).ok : FILE_PATH_RE.test(trimmed)
}

// Render a file path as a clean clickable link that opens the file viewer in a
// NEW browser tab, so the chat it was clicked from stays where it is.
// Monospace + blue underline (no code-box background — that looked like an empty highlight).
function FileLink({ path }: { path: string }) {
  const sessionId = useFileLinkSession()
  const link = buildChatFileLink(path, sessionId)
  if (!link) return path
  const { trimmed, href } = link
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${trimmed} in a new tab`}
      className="text-[var(--system-blue)] underline decoration-[var(--system-blue)]/40 hover:decoration-[var(--system-blue)] underline-offset-2 font-[family-name:var(--font-code)] text-[0.88em]"
    >
      {path}
    </a>
  )
}

export function renderPathLink(p: string, key: React.Key): React.ReactNode {
  return <FileLink key={key} path={p} />
}
