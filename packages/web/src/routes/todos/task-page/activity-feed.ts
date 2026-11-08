import type { WorkItemCommentWire, WorkItemEventWire, WorkItemRunOutcomeWire, WorkItemRunWire } from "@/lib/api"
import { buildCommentThread, type CommentThreadNode } from "../comment-thread"

/* The activity feed's pure model: audit events, comment threads and run
 * attempts merged into the one chronological stream the page reads bottom-up,
 * with quiet stretches of audit events folded away. The rendering that sits on
 * top of it lives in activity.tsx. */

const FOLD_THRESHOLD = 3
const HTML_COMMENT_LINE = /^\s*<!--(?:(?!-->).)*-->\s*$/

/** Comment voices render themselves; their audit shadows would double them. */
const FEED_HIDDEN_KINDS = new Set(["comment_added", "comment_edited", "comment_deleted", "none"])

/* A run enters the stream twice: once where it started and, once it has
 * reported an outcome, again where it settled. An attempt still in flight has
 * only the start — the stream has no outcome to show and must not invent one. */
type FeedEntry =
  | { kind: "comment"; at: string; node: CommentThreadNode }
  | { kind: "event"; at: string; event: WorkItemEventWire }
  | { kind: "run-start"; at: string; run: WorkItemRunWire }
  | { kind: "run-end"; at: string; run: WorkItemRunWire; outcome: WorkItemRunOutcomeWire }

export type FeedBlock = FeedEntry | { kind: "fold"; events: WorkItemEventWire[] }

/** Where a thread sits in the stream. Threading is single-level, so a block
 *  carries several timestamps and gets one position — and it has to be the
 *  newest, or a reply written during an attempt sorts ahead of the attempt it
 *  answers and stops interleaving with it. */
function threadAt(node: CommentThreadNode): string {
  return node.replies.reduce((latest, reply) => (reply.createdAt > latest ? reply.createdAt : latest), node.comment.createdAt)
}

function runEntries(run: WorkItemRunWire): FeedEntry[] {
  const start: FeedEntry = { kind: "run-start", at: run.startedAt, run }
  if (run.endedAt === null || run.outcome === null) return [start]
  return [start, { kind: "run-end", at: run.endedAt, run, outcome: run.outcome }]
}

export function buildFeed(
  events: WorkItemEventWire[],
  comments: WorkItemCommentWire[],
  runs: WorkItemRunWire[],
): FeedBlock[] {
  const entries: FeedEntry[] = [
    ...events
      .filter((event) => !FEED_HIDDEN_KINDS.has(event.kind))
      .map((event): FeedEntry => ({ kind: "event", at: event.createdAt, event })),
    ...buildCommentThread(comments).map((node): FeedEntry => ({ kind: "comment", at: threadAt(node), node })),
    ...runs.flatMap(runEntries),
  ].sort((a, b) => a.at.localeCompare(b.at))

  const blocks: FeedBlock[] = []
  let quiet: WorkItemEventWire[] = []
  const flushQuiet = () => {
    if (quiet.length >= FOLD_THRESHOLD) blocks.push({ kind: "fold", events: quiet })
    else for (const event of quiet) blocks.push({ kind: "event", at: event.createdAt, event })
    quiet = []
  }
  for (const entry of entries) {
    // Only an ordinary audit event is quiet enough to fold away. A comment, a
    // run boundary, and the birth whisper each end the stretch and stand alone.
    if (entry.kind === "event" && entry.event.kind !== "created") {
      quiet.push(entry.event)
      continue
    }
    flushQuiet()
    blocks.push(entry)
  }
  flushQuiet()
  return blocks
}

export function stripCommentMarkers(body: string): string {
  let inCodeBlock = false
  return body.split("\n").filter((line) => {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock
      return true
    }
    return inCodeBlock || !HTML_COMMENT_LINE.test(line)
  }).join("\n")
}
