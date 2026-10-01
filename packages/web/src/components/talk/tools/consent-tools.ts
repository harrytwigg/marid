import { api } from "@/lib/api"
import { withConsent } from "./consent"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"
import { writeFailed } from "./write-lane"

/**
 * The situation-first lane: writes that reach past this browser.
 *
 * None of these gets an undo, and that is the reason each is here rather than in
 * the fast lane. A workflow run spends money and wakes agents the moment it
 * starts; a reading is a permanent point on a measurement series with no delete
 * route at all; a message to a session may have been acted on in the world
 * before any window could close. A fifteen-second offer to take those back would
 * be a button that lies.
 */

const startWorkflowRun: TalkTool = {
  name: "talk_start_workflow_run",
  description: "Start a run of a workflow. Asks first: a run spends money and wakes agents as soon as it begins.",
  parameters: params({ id: str("The workflow id.") }, ["id"]),
  execute: (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    return withConsent(
      { tool: "talk_start_workflow_run", title: `Start a run of ${id}?`, hint: "It spends money and wakes agents immediately. Cancelling later does not undo what it did.", confirm: "Start the run", subject: id },
      async () => {
        try {
          const run = await api.startWorkflowRunV2(id)
          return { ok: true, data: { performed: `Started a run of ${id}.`, subject: id, runId: run.id, status: run.status } }
        } catch (error) {
          return writeFailed(`start a run of ${id}`, error)
        }
      },
    )
  },
}

export const NAMED_SESSION_SEND_TOOL: TalkTool = {
  name: "talk_send_to_session",
  description: "Send a message into a chat session. Asks first: whoever is on it may act on the message straight away.",
  parameters: params(
    { id: str("The session id."), message: str("What to send, in the operator's words.") },
    ["id", "message"],
  ),
  execute: (args: ToolArgs): Promise<ToolResult> => {
    const id = String(args.id)
    const message = String(args.message)
    return withConsent(
      { tool: "talk_send_to_session", title: "Send this to the session?", hint: message, confirm: "Send it", subject: id },
      async () => {
        try {
          await api.sendMessage(id, { message })
          return { ok: true, data: { performed: `Sent it to session ${id}.`, subject: id } }
        } catch (error) {
          return writeFailed(`send to session ${id}`, error)
        }
      },
    )
  },
}

export const CONSENT_TOOLS: readonly TalkTool[] = [startWorkflowRun, NAMED_SESSION_SEND_TOOL]
