import type { Employee } from "@/lib/api"

/* The @mention token rule. The gateway wakes an employee from a comment by this
 * same rule, so the picker and the chip renderer read it from here and the page
 * never highlights a name that will not wake anyone. */

/** A character that, directly before an `@`, makes it part of something else —
 *  an email address, a path, a handle, `@@`. */
const NOT_A_BOUNDARY = /[A-Za-z0-9_.@/-]/
const NAME_CHAR = /[A-Za-z0-9_-]/

/** A mention token found in text: `start` is the `@`, `end` is one past the name
 *  as the gateway reads it (trailing `-`/`_` left out), `name` is lowercased. */
export interface MentionToken {
  name: string
  start: number
  end: number
}

function atBoundary(text: string, at: number): boolean {
  return at === 0 || !NOT_A_BOUNDARY.test(text[at - 1])
}

/** Read the name that begins at `from`, or null when there is none. */
function readName(text: string, from: number): { name: string; end: number } | null {
  if (from >= text.length || !/[A-Za-z0-9]/.test(text[from])) return null
  let end = from + 1
  while (end < text.length && NAME_CHAR.test(text[end])) end++
  while (text[end - 1] === "-" || text[end - 1] === "_") end--
  return { name: text.slice(from, end).toLowerCase(), end }
}

/** Mention tokens in a run of prose. Code is the caller's business: a markdown
 *  renderer has already set it apart, so it never reaches this function. */
export function scanMentions(prose: string): MentionToken[] {
  const found: MentionToken[] = []
  for (let at = prose.indexOf("@"); at !== -1; at = prose.indexOf("@", at + 1)) {
    if (!atBoundary(prose, at)) continue
    const name = readName(prose, at + 1)
    if (name) found.push({ name: name.name, start: at, end: name.end })
  }
  return found
}

/** Spans that are code in raw markdown: fenced blocks (an unclosed fence runs to
 *  the end) and single-line inline code. */
function codeSpans(markdown: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const fenced = /```[\s\S]*?(?:```|$)/g
  for (let m = fenced.exec(markdown); m; m = fenced.exec(markdown)) spans.push([m.index, m.index + m[0].length])
  const inline = /`[^`\n]*`/g
  for (let m = inline.exec(markdown); m; m = inline.exec(markdown)) {
    const [start, end] = [m.index, m.index + m[0].length]
    if (!spans.some(([s, e]) => start >= s && start < e)) spans.push([start, end])
  }
  return spans
}

/** Mention tokens in a raw markdown comment body, code excluded. */
export function findMentions(markdown: string): MentionToken[] {
  const spans = codeSpans(markdown)
  return scanMentions(markdown).filter((t) => !spans.some(([s, e]) => t.start >= s && t.start < e))
}

/** The people a mention can name: the org's employees, system ones left out. */
export function mentionRoster(employees: Iterable<Employee>): Employee[] {
  return [...employees].filter((e) => !e.system)
}

/** The `@prefix` being typed at the caret, if any. `start` is the `@`. The
 *  prefix may be empty (a bare `@`). */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
  let at = caret - 1
  while (at >= 0 && NAME_CHAR.test(text[at])) at--
  if (at < 0 || text[at] !== "@" || !atBoundary(text, at)) return null
  return { start: at, query: text.slice(at + 1, caret) }
}

export const MENTION_PICKER_LIMIT = 8

/** Roster members whose name or display name starts with `query`, case-insensitive. */
export function filterMentionCandidates(roster: Employee[], query: string): Employee[] {
  const q = query.toLowerCase()
  return roster
    .filter((e) => e.name.toLowerCase().startsWith(q) || e.displayName.toLowerCase().startsWith(q))
    .slice(0, MENTION_PICKER_LIMIT)
}

/** Replace the typed `@prefix` (from `start` to `caret`) with `@name ` and say
 *  where the caret belongs afterwards. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  name: string,
): { value: string; caret: number } {
  const inserted = `@${name} `
  return { value: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length }
}
