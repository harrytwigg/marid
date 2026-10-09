import { api, type WorkItemStatusWire } from "@/lib/api"
import { legalTargets } from "@/lib/legal-targets"
import { withConsent } from "./consent"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"
import { writeFailed } from "./write-lane"

/**
 * Unblocking a Todo, spoken.
 *
 * An unblock reaches past this browser the moment it lands: it puts an agent
 * back on the work, and has no reversal, so it is situation-first — the sheet
 * is what stands in for the undo the fast lane would have offered.
 *
 * It reads the Todo BEFORE it asks, so a call against one that is not blocked
 * is refused without troubling the operator at all.
 */

const TALK = "talk" as const

/** What the edge map offers out of `blocked`. Whether THIS Todo may take one of
 *  them now still depends on its sub-tasks, and is checked when the call comes. */
const UNBLOCK_TARGETS: readonly WorkItemStatusWire[] = legalTargets("blocked").map((target) => target.status)

/** The close gate's pre-check, read the way the quick pickers read it: a failed
 *  read is reported rather than counted as zero, because defaulting to zero
 *  would offer a close the gateway is about to refuse and blame the move for a
 *  read that never landed. */
async function openChildrenOf(id: string): Promise<number | { error: string }> {
  try {
    const { tree } = await api.getWorkItemTree(id)
    return (tree.root.children ?? []).filter((child) => child.status !== "done" && child.status !== "cancelled").length
  } catch (error) {
    const why = error instanceof Error && error.message ? error.message : "the gateway did not answer"
    return { error: `Could not read ${id}'s sub-tasks, so the move cannot be checked against the close gate: ${why}.` }
  }
}

/**
 * Why the unblock as spoken cannot be made, or null when it can.
 *
 * The board offers a Done over open sub-tasks live, as a cascade that closes
 * the whole subtree with it. Voice does not get that verb, so this refuses it
 * in its own words rather than taking the edge map's verdict: it is the same
 * call `canDropOn` already makes about a drag — a spoken sentence says nothing
 * about the sub-tasks it would close, and speech is a weaker confirmation than
 * a drag, not a stronger one. The cascade stays where it was designed to be
 * decided: on a row that names what it closes, under a deliberate click.
 */
function refuseUnblock(id: string, status: WorkItemStatusWire, openChildren: number): string | null {
  const offered = legalTargets("blocked", { openChildren })
  const target = offered.find((option) => option.status === status)
  if (!target || target.gated) {
    const open = offered.filter((option) => !option.gated && !option.cascade).map((option) => option.status).join(", ")
    const why = target?.reason ? ` (${target.reason})` : ""
    return `${id} cannot move from blocked to ${status}${why}. It can go to: ${open}.`
  }
  if (target.cascade) {
    return `Closing ${id} would close ${openChildren} sub-task${openChildren === 1 ? "" : "s"} still open under it, and a spoken command is not where that gets decided. Open ${id} on the board and use its close action, which names everything it takes with it.`
  }
  return null
}

const unblockTodo: TalkTool = {
  name: "talk_unblock_todo",
  description:
    "Move a blocked Todo back into the flow, with the reason it is no longer blocked. Asks first: unblocking releases the work to whoever picks it up, and no undo reaches them.",
  parameters: params(
    {
      id: str("The full Todo id."),
      status: str("Where it goes now.", UNBLOCK_TARGETS),
      note: str("Why it is no longer blocked, in the operator's words. Ask them if they have not said."),
    },
    ["id", "status", "note"],
  ),
  execute: async (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const status = String(args.status) as WorkItemStatusWire
    const note = String(args.note)

    let was: WorkItemStatusWire
    try {
      was = (await api.getWorkItem(id)).workItem.status
    } catch (error) {
      return writeFailed(`read ${id} before unblocking it`, error)
    }
    if (was !== "blocked") {
      return { ok: false, error: `${id} is not blocked — it is ${was}, so there is nothing to unblock. Use "talk_set_todo_status" to move it.` }
    }

    const children = await openChildrenOf(id)
    if (typeof children !== "number") return { ok: false, error: children.error }

    const refusal = refuseUnblock(id, status, children)
    if (refusal) return { ok: false, error: refusal }

    return withConsent(
      {
        tool: "talk_unblock_todo",
        title: `Unblock ${id} to ${status}?`,
        hint: note,
        confirm: "Unblock it",
        subject: id,
      },
      async () => {
        try {
          await api.setWorkItemStatus(id, status, note, TALK)
          return { ok: true, data: { performed: `Unblocked ${id} to ${status}.`, subject: id, from: "blocked", status } }
        } catch (error) {
          return writeFailed(`unblock ${id} to ${status}`, error)
        }
      },
    )
  },
}

export const UNBLOCK_TOOLS: readonly TalkTool[] = [unblockTodo]
