import type { WorkItemDetailWire, WorkItemFullWire, WorkflowRunSummaryWire } from "@/lib/api"

/**
 * Wire shapes trimmed to what a voice model can hold and say back.
 *
 * A read tool's result is spoken, not rendered, and every field costs context in
 * a session that is already paying for audio. So these keep the fields a person
 * would actually ask about and drop the rest, and they cap free text at a length
 * that survives being read aloud.
 */

const BODY_CHARS = 600
const COMMENT_CHARS = 280
const MESSAGE_CHARS = 400
const RECENT_COMMENTS = 5
const RECENT_MESSAGES = 6

/** Collapse whitespace and cap length. Truncation is marked, never silent: a
 *  model that reads a cut-off sentence as the whole answer misreports it. */
export function clip(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated)`
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

/** The tail of the conversation on a Todo, with an honest count of the rest.
 *  Tombstones keep their row so the thread shape survives a deletion; there is
 *  nothing in one to say out loud, and a model reading an empty comment aloud
 *  would report a deletion as a message. */
function trimComments(detail: WorkItemDetailWire): Record<string, unknown> {
  const all = (detail.comments?.comments ?? []).filter((comment) => !comment.deletedAt)
  return {
    commentCount: detail.comments?.total ?? all.length,
    comments: all.slice(-RECENT_COMMENTS).map((comment) => ({
      author: comment.author,
      at: comment.createdAt,
      body: clip(comment.body, COMMENT_CHARS),
    })),
  }
}

/** The gate on a Todo, so the orb can narrate a decision before it offers to
 *  make one — including whether the answer wanted is a yes/no or a pick. */
function trimApproval(item: WorkItemFullWire): Record<string, unknown> {
  return {
    approvalState: item.approvalState ?? null,
    approvalRequest: item.approvalRequest ? clip(item.approvalRequest, COMMENT_CHARS) : null,
    approvalOptions: item.approvalOptions ?? null,
    approvalOperatorOnly: item.approvalOperatorOnly ?? false,
  }
}

export function trimTodo(detail: WorkItemDetailWire, includeComments: boolean): Record<string, unknown> {
  const item = detail.workItem
  const trimmed: Record<string, unknown> = {
    id: item.id,
    title: item.title,
    status: item.status,
    assignee: item.assignee ?? null,
    department: item.department ?? null,
    parentId: item.parentId ?? null,
    dueAt: item.dueAt ?? null,
    updatedAt: item.updatedAt,
    labels: (detail.labels ?? []).map((label) => label.name),
    body: clip(item.body, BODY_CHARS),
    ...trimApproval(item),
  }
  return includeComments ? { ...trimmed, ...trimComments(detail) } : trimmed
}

/** The session record is untyped on the wire, so every field is read defensively
 *  and a missing one reports as null rather than disappearing. */
export function trimSession(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const history = Array.isArray(raw.messages) ? raw.messages : Array.isArray(raw.history) ? raw.history : []
  const recent = history.slice(-RECENT_MESSAGES).map((entry) => {
    const message = (entry ?? {}) as Record<string, unknown>
    return { role: str(message.role) ?? "unknown", text: clip(message.content, MESSAGE_CHARS) }
  })
  return {
    id: str(raw.id) ?? id,
    title: str(raw.title),
    employee: str(raw.employee),
    status: str(raw.status),
    lastActivity: str(raw.lastActivity),
    messageCount: history.length,
    messages: recent,
  }
}

export function trimWorkflowRuns(runs: readonly WorkflowRunSummaryWire[], limit: number): Record<string, unknown>[] {
  return runs.slice(0, limit).map((run) => ({
    runId: run.id,
    status: run.status,
    trigger: run.trigger.kind,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    // What it is doing now, or what stopped it — the one thing worth saying
    // out loud about a run that is not simply "completed".
    node: run.currentOrFailingNode ? `${run.currentOrFailingNode.label} (${run.currentOrFailingNode.state})` : null,
  }))
}
