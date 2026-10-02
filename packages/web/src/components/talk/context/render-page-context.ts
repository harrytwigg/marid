/**
 * The snapshot, in the words the model reads.
 *
 * This owns the size of ambient context. The text is pushed as the session's
 * `instructions`, a replaced field, so it costs its length once rather than once
 * per turn — but a page with four hundred cards on it would still be four
 * hundred cards of it, so the budget is enforced here and the object list is the
 * only part allowed to give ground.
 */
import { clip } from "../tools/read-shapes"
import type { PageKind, PageSnapshot, SemanticObject, TalkScreenContext } from "./page-snapshot"
import type { InstanceIdentity } from "./instance-identity"
import type { VisibleObject } from "./visible-objects"

/**
 * ~300 tokens at the gateway's documented four-chars-per-token estimate
 * (`talk/session/context.ts`), against its `TALK_CONTEXT_BUDGET_TOKENS` of 6000.
 */
export const PAGE_CONTEXT_BUDGET_CHARS = 1200

/** Long enough for a real Todo title, short enough that a dozen of them fit. */
const TITLE_CHARS = 60
/** The route, a filter value or an id, capped so no single operator-typed string
 *  can eat the budget the rest of the snapshot needs. */
const VALUE_CHARS = 120

const SURFACE_LABEL: Record<PageKind, string> = {
  chat: "Chat",
  todos: "Todos board",
  todo: "Todo",
  org: "Org",
  cron: "Cron",
  notes: "Notes",
  logs: "Activity",
  limits: "Limits",
  "auto-dispatch": "Auto-Dispatch",
  settings: "Settings",
  "settings-plugins": "Plugin settings",
  skills: "Skills",
  skill: "Skill",
  file: "File",
  more: "More",
  "talk-orb": "Talk orb bench",
  redesign: "Design bench",
  plugin: "Plugin",
  other: "Page",
}

const PREAMBLE =
  "What the operator is looking at right now, in their Jinn web UI. "
  + "This is live page context: it is replaced whenever they move, and it is not something they said to you. "
  + "Speak titles, people, topics, and relative time; speak names, not identifiers unless explicitly asked."

function pairs(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${clip(value, VALUE_CHARS)}`)
    .join(", ")
}

function chatBlockLine(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null
  const block = raw as Record<string, unknown>
  const detail = [block.title, block.status, block.summary]
    .filter((value): value is string => typeof value === "string" && Boolean(value))
    .map((value) => clip(value, 240))
    .join(" · ")
  if (!detail) return null
  return `Stable ${clip(String(block.type ?? "block"), TITLE_CHARS)} (${clip(String(block.recency ?? "this turn"), TITLE_CHARS)}): ${detail}`
}

function recentChatLine(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null
  const block = raw as { role?: unknown; text?: unknown; recency?: unknown }
  if (typeof block.role !== "string" || typeof block.text !== "string") return null
  const when = typeof block.recency === "string" ? ` (${clip(block.recency, TITLE_CHARS)})` : ""
  return `Recent ${clip(block.role, TITLE_CHARS)}${when}: ${clip(block.text, 240)}`
}

interface ChatTimelineItem {
  raw: unknown
  index: number
  kind: "stable" | "recent"
}

function timelineOrder(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null
  const order = (raw as Record<string, unknown>).order
  return typeof order === "number" ? order : null
}

function compareChatItems(a: ChatTimelineItem, b: ChatTimelineItem): number {
  const aOrder = timelineOrder(a.raw)
  const bOrder = timelineOrder(b.raw)
  if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return bOrder - aOrder
  if (aOrder !== null && bOrder === null) return -1
  if (aOrder === null && bOrder !== null) return 1
  if (a.kind !== b.kind) return a.kind === "recent" ? -1 : 1
  return b.index - a.index
}

function chatLines(object: SemanticObject): string[] {
  const participants = Array.isArray(object.fields.participants)
    ? object.fields.participants.filter((value): value is string => typeof value === "string")
    : []
  const activity = typeof object.fields.activity === "string" ? object.fields.activity : ""
  const stable = Array.isArray(object.fields.stableBlocks) ? object.fields.stableBlocks : []
  const recent = Array.isArray(object.fields.recentBlocks) ? object.fields.recentBlocks : []
  const timeline = [
    ...stable.map((raw, index) => ({ raw, index, kind: "stable" as const })),
    ...recent.map((raw, index) => ({ raw, index, kind: "recent" as const })),
  ].sort(compareChatItems)
  return [
    participants.length > 0 ? `Participants: ${participants.map((value) => clip(value, TITLE_CHARS)).join(", ")}` : null,
    activity ? `Activity: ${clip(activity, TITLE_CHARS)}` : null,
    ...timeline.map((item) => item.kind === "stable" ? chatBlockLine(item.raw) : recentChatLine(item.raw)),
  ].filter((line): line is string => Boolean(line))
}

function scalarFields(object: SemanticObject): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(object.fields).flatMap(([key, value]) =>
    (object.kind === "chat session" && key === "activity")
    || value === null || value === undefined || typeof value === "object"
      ? []
      : [[key, String(value)]]))
}

function semanticLines(screen: TalkScreenContext): string[] {
  const lines = [`Context: revision ${screen.revision}, ${screen.freshness}, captured ${clip(screen.capturedAt, VALUE_CHARS)}`]
  const object = screen.selectedObject
  if (object) {
    lines.push(`Object: ${clip(object.title, VALUE_CHARS)}${object.status ? ` · ${clip(object.status, VALUE_CHARS)}` : ""}`)
    if (object.kind === "chat session") lines.push(...chatLines(object))
    const fields = pairs(scalarFields(object))
    if (fields) lines.push(`State: ${fields}`)
    if (object.relations.length > 0) lines.push(`Relations: ${object.relations.map((relation) => `${relation.kind}:${relation.id}`).join(", ")}`)
    if (object.kind !== "chat session") {
      lines.push(`Retrieve: ${pairs(Object.fromEntries(Object.entries(object.retrievalAnchor).map(([key, value]) => [key, String(value)])))}`)
    }
  }
  if (screen.controls.length > 0) lines.push(`Controls: ${screen.controls.slice(0, 8).map((control) => `${control.operation}:${clip(control.label, TITLE_CHARS)}`).join("; ")}`)
  if (screen.meaningfulText) lines.push(`Visible meaning: ${clip(screen.meaningfulText, 300)}`)
  if (screen.missing.length > 0) lines.push(`Missing: ${screen.missing.map((value) => clip(value, VALUE_CHARS)).join(", ")}`)
  return lines
}

/** The lines that are never traded away for room: which Jinn, which page, which
 *  filters, what is selected. */
function fixedLines(snapshot: PageSnapshot, instance: InstanceIdentity): string[] {
  const lines = [
    PREAMBLE,
    `Instance: ${clip(instance.name, VALUE_CHARS)} on port ${clip(instance.port, VALUE_CHARS)}`,
    `Page: ${SURFACE_LABEL[snapshot.kind]} at ${clip(snapshot.path, VALUE_CHARS)}`,
  ]
  const route = pairs(snapshot.params)
  if (route) lines.push(`Route: ${route}`)
  // Selection before filters: both are clipped field by field and so both fit
  // in every real case, but a page carrying an absurd number of filters is
  // clamped from the tail, and the filters are the part that may go.
  if (snapshot.selection) {
    const semantic = "version" in snapshot ? (snapshot as TalkScreenContext).selectedObject : null
    const selected = snapshot.selection.kind === "chat session"
      ? `chat ${semantic?.title ? clip(semantic.title, VALUE_CHARS) : "current"}`
      : `${snapshot.selection.kind} ${clip(snapshot.selection.id, VALUE_CHARS)}`
    lines.push(`Selected: ${selected}`)
    // The one identifier the packet carries, and only for what the operator has
    // actually selected. Without it the model can read the chat's title off the
    // screen but cannot name the session to any tool, so asked what it is
    // looking at it narrates instead of reading — the hallucination PLA-224 was
    // raised for. Every other session on screen stays a title (`objectLine`
    // withholds ids on a chat page), and this one is stated as a handle so the
    // preamble's "speak names, not identifiers" still holds for what is said.
    if (snapshot.selection.kind === "chat session") {
      lines.push(`Selected session id: ${clip(snapshot.selection.id, VALUE_CHARS)}. Use as the id for session tools (read or send); a handle to use, never something to say.`)
    }
  }
  if ("version" in snapshot) lines.push(...semanticLines(snapshot as TalkScreenContext))
  const filters = pairs(snapshot.filters)
  if (filters) lines.push(`Filters: ${filters}`)
  return lines
}

function entryFor(object: VisibleObject, includeId: boolean): string {
  const title = clip(object.title, TITLE_CHARS)
  if (!includeId) return title || "Untitled chat"
  return title ? `${object.id} ${title}` : object.id
}

/** The object line carrying exactly `shown` of them, and an honest count of the
 *  rest. Truncation is stated: a model that reads a cut list as the whole board
 *  answers "twelve Todos" for a board of four hundred. */
function objectLine(objects: readonly VisibleObject[], shown: number, includeIds: boolean): string {
  const dropped = objects.length - shown
  const listed = objects.slice(0, shown).map((object) => entryFor(object, includeIds))
  if (dropped > 0) listed.push(`+${dropped} more`)
  return `On screen (${shown} of ${objects.length}): ${listed.join("; ")}`
}

/**
 * Render one snapshot, inside the budget.
 *
 * The fixed lines are clipped field by field, so they are bounded before any
 * budget arithmetic happens; the object list then takes whatever room is left,
 * one entry at a time, and is dropped whole if there is none.
 */
export function renderPageContext(
  snapshot: PageSnapshot,
  objects: readonly VisibleObject[],
  instance: InstanceIdentity,
): string {
  const fixed = fixedLines(snapshot, instance).join("\n").slice(0, PAGE_CONTEXT_BUDGET_CHARS)
  if (objects.length === 0) return fixed

  let best = ""
  for (let shown = 1; shown <= objects.length; shown += 1) {
    const line = objectLine(objects, shown, snapshot.kind !== "chat")
    if (fixed.length + 1 + line.length > PAGE_CONTEXT_BUDGET_CHARS) break
    best = line
  }
  return best === "" ? fixed : `${fixed}\n${best}`
}
