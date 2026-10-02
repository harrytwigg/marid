import { Clock, Hash, ListChecks, MessageSquare, NotebookPen, Users, Zap, type LucideIcon } from "lucide-react"
import type { SearchKind, SearchMatchFieldWire } from "@/lib/search-api"

export interface KindMeta {
  label: string
  /** The group head above a run of this kind. */
  plural: string
  Icon: LucideIcon
}

export const KIND_META: Record<SearchKind, KindMeta> = {
  todo: { label: "Todo", plural: "Todos", Icon: ListChecks },
  session: { label: "Session", plural: "Sessions", Icon: MessageSquare },
  note: { label: "Note", plural: "Notes", Icon: NotebookPen },
  employee: { label: "Employee", plural: "People", Icon: Users },
  cron: { label: "Cron job", plural: "Cron", Icon: Clock },
  skill: { label: "Skill", plural: "Skills", Icon: Zap },
  page: { label: "Page", plural: "Pages", Icon: Hash },
}

const RECENT_META: KindMeta = { label: "Recent", plural: "Recent", Icon: Hash }

export function metaFor(kind: SearchKind | "recent"): KindMeta {
  return kind === "recent" ? RECENT_META : KIND_META[kind]
}

/** The matched field, as the list subline names it. */
export const FIELD_LABEL: Record<SearchMatchFieldWire, string> = {
  id: "id", title: "title", body: "body", comment: "comment",
  name: "name", description: "description", prompt: "prompt", persona: "persona", path: "path",
  status: "status", assignee: "assignee", department: "department", label: "label",
}

/** The same field, as the preview attributes the snippet it just showed. */
export const FIELD_ATTRIBUTION: Record<SearchMatchFieldWire, string> = {
  id: "the id itself",
  title: "in the title",
  body: "in the body",
  comment: "in a comment",
  name: "in the name",
  description: "in the description",
  prompt: "in the prompt",
  persona: "in the persona",
  path: "in the path",
  status: "matched the status filter",
  assignee: "matched the assignee filter",
  department: "matched the department filter",
  label: "matched the label filter",
}

/** A status disc takes a colour only where the state is one. Blocked is orange
 *  because that is the colour the Todos board already gives it. */
export function statusTint(status: string): string {
  const state = status.toLowerCase()
  if (state === "blocked") return "var(--system-orange)"
  if (state === "crashed" || state === "failed" || state === "disabled") return "var(--system-red)"
  if (state === "done" || state === "completed" || state === "enabled") return "var(--system-green)"
  return "var(--text-quaternary)"
}
