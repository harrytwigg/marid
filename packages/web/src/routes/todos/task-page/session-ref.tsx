import { createContext, useContext } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowUpRight } from "lucide-react"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { sessionIdFromActor, type SessionDirectoryEntryWire } from "@/lib/session-tree-api"
import { displayNameOf } from "../util"

/**
 * A session named on a Todo, rendered as something you can get to.
 *
 * Every surface on the Todo page that knew a session's id threw it away: the
 * rail printed `createdBy` through a helper that falls back to the raw key, so
 * a Todo minted by a session showed `session:<uuid>` as text; the audit line
 * called it "A session"; the comment thread did the same. Only a LIVE
 * todo-dispatcher was clickable. The identity was in hand every time.
 *
 * The directory arrives by context rather than by prop because the three
 * surfaces that need it — the rail, the audit whisper, the comment thread —
 * sit at unrelated depths, and `activity.tsx` and `task-page.tsx` are both at
 * their recorded size budgets: threading a prop through them is lines those
 * files do not have.
 */

const SessionDirectory = createContext<Record<string, SessionDirectoryEntryWire> | undefined>(undefined)

export function SessionDirectoryProvider({
  directory,
  children,
}: {
  directory: Record<string, SessionDirectoryEntryWire> | undefined
  children: React.ReactNode
}) {
  return <SessionDirectory.Provider value={directory}>{children}</SessionDirectory.Provider>
}

export function useSessionDirectory(): Record<string, SessionDirectoryEntryWire> | undefined {
  return useContext(SessionDirectory)
}

/** Live states get the pulsing dot. Matches the rail's existing dispatch chip
 *  rather than introducing a second vocabulary for the same thing. */
const LIVE = new Set(["running", "waiting"])

export interface SessionRefProps {
  sessionId: string
  byName: Map<string, Employee>
  /** Compact form for an inline audit or comment line: name only, no avatar. */
  inline?: boolean
  /** Text to show in place of the session's name, when the surrounding line
   *  already says whose it is. */
  label?: string
}

/** The name to show when the directory has no entry — a shortened id beats
 *  inventing a label, and still identifies the session in a log. */
function shortId(sessionId: string): string {
  return `Session ${sessionId.slice(0, 8)}`
}

export function sessionRefLabel(
  sessionId: string,
  directory: Record<string, SessionDirectoryEntryWire> | undefined,
  byName: Map<string, Employee>,
): string {
  const entry = directory?.[sessionId]
  if (!entry || entry.missing) return shortId(sessionId)
  if (entry.employee) return displayNameOf(entry.employee, byName)
  return entry.title?.trim() || shortId(sessionId)
}

/** An actor string that MAY name a session: `children` is what to show when it
 *  does not. Both call sites — the audit whisper and the comment thread — sit in
 *  files at their size budget, so the branch lives here rather than in each. */
export function SessionActor({
  actor,
  byName,
  children,
}: {
  actor: string | null | undefined
  byName: Map<string, Employee>
  children: React.ReactNode
}) {
  const sessionId = sessionIdFromActor(actor)
  if (!sessionId) return <>{children}</>
  return <SessionRef sessionId={sessionId} byName={byName} inline />
}

/** The "session" link in a comment's header: the session that wrote the comment.
 *  Absent when the gateway did not record one (older comments, and comments
 *  written from the browser). */
export function CommentSessionLink({ sessionId, byName }: { sessionId: string | undefined; byName: Map<string, Employee> }) {
  if (!sessionId) return null
  return (
    <span className="text-[10.5px] text-[var(--text-quaternary)]">
      <SessionRef sessionId={sessionId} byName={byName} inline label="session" />
    </span>
  )
}

/** Named but unreachable: a link to a session that is gone is worse than text. */
function MissingRef({ sessionId, label }: { sessionId: string; label: string }) {
  return (
    <span data-testid={`session-ref-missing-${sessionId}`} className="text-[var(--text-quaternary)]" title="This session no longer exists">
      {label}
    </span>
  )
}

function InlineRef({ sessionId, label, onOpen }: { sessionId: string; label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid={`session-ref-${sessionId}`}
      data-session-id={sessionId}
      onClick={onOpen}
      className="focus-ring rounded-[5px] underline decoration-[var(--separator)] underline-offset-2 outline-none hover:decoration-[var(--text-tertiary)]"
    >
      {label}
    </button>
  )
}

/** The leading glyph: the employee's avatar when there is one, a neutral disc
 *  otherwise — a session without an employee is still a real session. */
function RefGlyph({ employee }: { employee: string | null | undefined }) {
  if (!employee) return <span className="size-1.5 flex-none rounded-full bg-[var(--fill-primary)]" aria-hidden />
  return <EmployeeAvatar name={employee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
}

/** What the session is doing right now, if anything worth a glance. */
function RefState({ entry }: { entry: SessionDirectoryEntryWire | undefined }) {
  if (entry?.archived) return <span className="flex-none text-[11.5px] text-[var(--text-quaternary)]">Archived</span>
  if (!LIVE.has(entry?.status ?? "")) return null
  return (
    <span
      className="size-1.5 flex-none rounded-full bg-[var(--system-blue)] motion-safe:animate-[jinn-pulse_1.4s_ease-in-out_infinite]"
      aria-label="Working"
    />
  )
}

export function SessionRef({ sessionId, byName, inline, label: labelOverride }: SessionRefProps) {
  const navigate = useNavigate()
  const directory = useSessionDirectory()
  const entry = directory?.[sessionId]
  const label = labelOverride ?? sessionRefLabel(sessionId, directory, byName)
  const onOpen = () => navigate(`/?session=${encodeURIComponent(sessionId)}`)

  if (entry?.missing) return <MissingRef sessionId={sessionId} label={label} />
  if (inline) return <InlineRef sessionId={sessionId} label={label} onOpen={onOpen} />

  return (
    <button
      type="button"
      data-testid={`session-ref-${sessionId}`}
      data-session-id={sessionId}
      onClick={onOpen}
      className="focus-ring group/ref flex min-w-0 items-center gap-[7px] rounded-[7px] text-left outline-none"
    >
      <RefGlyph employee={entry?.employee} />
      <span className="min-w-0 truncate">{label}</span>
      <RefState entry={entry} />
      <ArrowUpRight
        size={12}
        aria-hidden
        className="flex-none text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover/ref:opacity-100"
      />
    </button>
  )
}
