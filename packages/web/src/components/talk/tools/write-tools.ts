import { api, isPositiveTodoVersion, type WorkItemStatusWire } from "@/lib/api"
import { canDropOn } from "@/lib/legal-targets"
import { newTodoEditRequest } from "@/routes/todos/todo-edit-request"
import { pendingUndo, takeUndo } from "../talk-undo-store"
import { recordTalkAction } from "../talk-action-log"
import { withConsent } from "./consent"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"
import { UNDO_TOOL, fastWrite, fastWriteFailed, writeFailed } from "./write-lane"

/**
 * The speak-and-go lane: internal, cheap, and reversible writes.
 *
 * Each one declares the reversal it hands to {@link fastWrite}, which is what
 * earns it the fast lane. Where an instance of one of these has no reversal, it
 * falls back to the consent lane rather than shipping an undo that lies:
 * `cancelled` always, and any status move the ledger has no way back from.
 */

const TALK = "talk" as const

/** Statuses an agent may move a Todo to; `cancelled` is deliberately here and
 *  handled apart, because the model has to be able to ASK for it in order for
 *  the sheet to be what says no. */
const STATUSES: readonly WorkItemStatusWire[] = [
  "backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled",
]

const commentTodo: TalkTool = {
  name: "talk_comment_todo",
  description: "Leave a comment on a Todo. Reversible for a short window afterwards.",
  parameters: params(
    { id: str("The full Todo id, such as \"ABC-59\"."), body: str("The comment to leave, in the operator's words.") },
    ["id", "body"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const body = String(args.body)
    try {
      const { comment } = await api.addWorkItemComment(id, body, undefined, TALK)
      return fastWrite({
        tool: "talk_comment_todo",
        subject: id,
        performed: `Commented on ${id}.`,
        reverse: async () => { await api.deleteWorkItemComment(id, comment.id, TALK) },
      })
    } catch (error) {
      return fastWriteFailed({ tool: "talk_comment_todo", subject: id }, `comment on ${id}`, error)
    }
  },
}

const createTodo: TalkTool = {
  name: "talk_create_todo",
  description: "Create a Todo. It starts in the backlog with nobody assigned.",
  parameters: params(
    {
      title: str("The Todo's title — one line, what the work is."),
      body: str("The detail, if the operator gave any."),
      parentId: str("The id of the Todo this belongs under, if it is a sub-task."),
    },
    ["title"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const title = String(args.title)
    try {
      const { workItem } = await api.createWorkItem({
        title,
        ...(typeof args.body === "string" && args.body ? { body: args.body } : {}),
        ...(typeof args.parentId === "string" && args.parentId ? { parentId: args.parentId } : {}),
      }, TALK)
      return fastWrite({
        tool: "talk_create_todo",
        subject: workItem.id,
        performed: `Created ${workItem.id}: ${workItem.title}.`,
        data: { title: workItem.title, status: workItem.status },
        // Archive rather than delete: the row and its audit survive, which is
        // what "undo" means everywhere else in the ledger.
        reverse: async () => { await api.archiveWorkItem(workItem.id) },
      })
    } catch (error) {
      return fastWriteFailed({ tool: "talk_create_todo", subject: null }, `create a Todo titled "${title}"`, error)
    }
  },
}

/** A status move with no undo behind it: the consent lane's half of the status
 *  tool. It never offers a reversal, which is the whole reason it asked. */
async function moveTodoOneWay(id: string, status: WorkItemStatusWire, note: string | undefined, performed: string): Promise<ToolResult> {
  try {
    const { workItem } = await api.setWorkItemStatus(id, status, note, TALK)
    return { ok: true, data: { performed, subject: workItem.id } }
  } catch (error) {
    return writeFailed(`move ${id} to ${status}`, error)
  }
}

const setTodoStatus: TalkTool = {
  name: "talk_set_todo_status",
  description: "Move a Todo to another status. Moves the board cannot take back — cancelling, closing, starting work — ask first; the rest are reversible for a short window.",
  parameters: params(
    {
      id: str("The full Todo id."),
      status: str("The status to move it to.", STATUSES),
      note: str("Why, when the move is to blocked or escalated."),
    },
    ["id", "status"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const status = String(args.status) as WorkItemStatusWire
    const note = typeof args.note === "string" && args.note ? args.note : undefined
    if (status === "cancelled") {
      return withConsent(
        { tool: "talk_set_todo_status", title: `Cancel ${id}?`, hint: "Cancelling closes the work. There is no undo for it.", confirm: "Cancel it", subject: id },
        () => moveTodoOneWay(id, status, note, `Cancelled ${id}.`),
      )
    }
    let wasStatus: WorkItemStatusWire
    try {
      wasStatus = (await api.getWorkItem(id)).workItem.status
    } catch (error) {
      return fastWriteFailed({ tool: "talk_set_todo_status", subject: id }, `move ${id} to ${status}`, error)
    }
    // Leaving `blocked` is an unblock however it was phrased, and the edge map
    // does not know that: `blocked → assigned` is reversible, so the fast lane
    // would take it on the model's word. Releasing work puts an agent on it, and
    // a fifteen-second undo does not reach whoever already started.
    if (wasStatus === "blocked") {
      return withConsent(
        { tool: "talk_set_todo_status", title: `Move ${id} out of blocked?`, hint: "Unblocking releases the work to whoever picks it up. There is no undo once it does.", confirm: "Move it", subject: id },
        () => moveTodoOneWay(id, status, note, `Moved ${id} to ${status}.`),
      )
    }
    // The board does not rewind every move: work that has started or closed has
    // no edge back to where it came from. `canDropOn` is the same parity-tested
    // legality the board drags on, read in the reverse direction — so a move the
    // ledger would refuse to undo asks first instead of promising a way back.
    if (!canDropOn(status, wasStatus)) {
      return withConsent(
        { tool: "talk_set_todo_status", title: `Move ${id} to ${status}?`, hint: `The board has no way back from ${status} to ${wasStatus}, so this one cannot be undone.`, confirm: "Move it", subject: id },
        () => moveTodoOneWay(id, status, note, `Moved ${id} to ${status}.`),
      )
    }
    try {
      const { workItem } = await api.setWorkItemStatus(id, status, note, TALK)
      return fastWrite({
        tool: "talk_set_todo_status",
        subject: id,
        performed: `Moved ${id} to ${status}.`,
        data: { from: wasStatus, status: workItem.status },
        reverse: async () => { await api.setWorkItemStatus(id, wasStatus, undefined, TALK) },
      })
    } catch (error) {
      return fastWriteFailed({ tool: "talk_set_todo_status", subject: id }, `move ${id} to ${status}`, error)
    }
  },
}

const assignTodo: TalkTool = {
  name: "talk_assign_todo",
  description: "Assign a Todo to an employee. Reversible for a short window afterwards.",
  parameters: params(
    { id: str("The full Todo id."), assignee: str("The employee's name, such as \"a-lead\".") },
    ["id", "assignee"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const assignee = String(args.assignee)
    try {
      const before = await api.getWorkItem(id)
      const wasAssignee = before.workItem.assignee
      const wasDepartment = before.workItem.department
      const wasStatus = before.workItem.status
      const { workItem } = await api.assignWorkItem(id, assignee, TALK)
      return fastWrite({
        tool: "talk_assign_todo",
        subject: id,
        performed: `Assigned ${id} to ${assignee}.`,
        data: { from: wasAssignee, assignee },
        reverse: async () => {
          // One assign writes three fields: the name, the department (the named
          // employee's, unless gateway.todoDepartments keeps it), and — out of the backlog — the
          // status. The assign route can only ever put back a department that
          // employee still has, so all of the ownership goes back through the
          // version-fenced edit lane, which can name both.
          const current = (await api.getWorkItem(id)).workItem
          if (!isPositiveTodoVersion(current.version)) {
            throw new Error(`${id} came back without a revision to fence the reversal against`)
          }
          // Read now rather than remembered from before: the assign bumped the
          // revision itself, so reusing what it saw would be a certain 409.
          await api.updateWorkItem(id, newTodoEditRequest({ assignee: wasAssignee, department: wasDepartment }, current.version))
          // Assigning a Todo out of the backlog also moves it, so restoring the
          // ownership is only half the reversal — the other half is where it sat.
          if (workItem.status !== wasStatus) await api.setWorkItemStatus(id, wasStatus, undefined, TALK)
        },
      })
    } catch (error) {
      return fastWriteFailed({ tool: "talk_assign_todo", subject: id }, `assign ${id} to ${assignee}`, error)
    }
  },
}

const labelTodo: TalkTool = {
  name: "talk_label_todo",
  description: "Replace a Todo's labels with the ones given. Only existing labels can be applied.",
  parameters: params(
    { id: str("The full Todo id."), labels: str("The full set of label names, comma-separated. Empty clears them.") },
    ["id", "labels"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const next = String(args.labels).split(",").map((name) => name.trim()).filter(Boolean)
    try {
      const before = await api.getWorkItem(id)
      const wasLabels = (before.labels ?? []).map((label) => label.name)
      const { labels } = await api.setWorkItemLabels(id, next, TALK)
      const applied = labels.map((label) => label.name)
      return fastWrite({
        tool: "talk_label_todo",
        subject: id,
        performed: applied.length > 0 ? `Labelled ${id}: ${applied.join(", ")}.` : `Cleared the labels on ${id}.`,
        data: { from: wasLabels, labels: applied },
        reverse: async () => { await api.setWorkItemLabels(id, wasLabels, TALK) },
      })
    } catch (error) {
      return fastWriteFailed({ tool: "talk_label_todo", subject: id }, `label ${id}`, error)
    }
  },
}

const undoLastWrite: TalkTool = {
  name: UNDO_TOOL,
  description: "Reverse the last speak-and-go write, while its window is still open. Every such write names this tool as its undo.",
  parameters: params({}),
  execute: async (): Promise<ToolResult> => {
    // A reversal that ran logs itself from the offer's own callback, whichever
    // surface took it. An undo with nothing on the table has no callback to do
    // that, and it is still an attempt the log has to show.
    if (!pendingUndo()) {
      recordTalkAction({ tool: UNDO_TOOL, subject: null, lane: "fast", consent: "not-required" })
    }
    const outcome = await takeUndo()
    return outcome.ok
      ? { ok: true, data: { performed: `Undone: ${outcome.performed}` } }
      : { ok: false, error: outcome.error }
  },
}

/** The speak-and-go tools, plus the reversal they all hand back. */
export const WRITE_TOOLS: readonly TalkTool[] = [
  commentTodo,
  createTodo,
  setTodoStatus,
  assignTodo,
  labelTodo,
  undoLastWrite,
]

/** The subset that must never succeed without a reversal on the table. */
export const FAST_LANE_TOOLS: readonly TalkTool[] = [commentTodo, createTodo, setTodoStatus, assignTodo, labelTodo]
