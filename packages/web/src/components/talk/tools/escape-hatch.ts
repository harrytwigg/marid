import { api } from "@/lib/api"
import { isTodoId } from "@/lib/todo-id"
import { withConsent } from "./consent"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"
import { writeFailed } from "./write-lane"

/**
 * The catch-all: an intent no named tool covers.
 *
 * It is the least predictable surface the orb has — the model reaches it exactly
 * when it has stopped matching a request to something the app can do — so it
 * never gets the fast lane and never acts on its own reading of a sentence. The
 * one thing it can resolve to is recording the ask against a Todo, which is the
 * honest answer to "no tool does this": keep it where it will be seen, and say
 * so out loud.
 *
 * ## The result contract
 *
 * Success is `{ ok: true, data: { performed, subject?, undo? } }` where
 * `performed` is a past-tense sentence the model can say back, and `undo` names
 * the tool call that reverses it, if one exists. Consent given here stands in
 * for the undo, so nothing is offered.
 *
 * Refusal is `{ ok: false, error }` — the operator declining, and the intent
 * this cannot resolve, read the same way to the caller. A write the operator has
 * not agreed to is a refusal, not a failure.
 */

export const ESCAPE_HATCH_TOOL: TalkTool = {
  name: "hundredfold_action",
  description:
    "Describe an action that no other tool covers. It asks the operator before doing anything, and can only record the request against a Todo.",
  parameters: params(
    {
      intent: str("What the operator asked for, in their own words."),
      subject: str("The id of the thing to act on, if there is one."),
      detail: str("Any text the action needs, such as a comment to leave."),
    },
    ["intent"],
  ),
  execute: (args: ToolArgs): Promise<ToolResult> => {
    const intent = String(args.intent)
    const subject = typeof args.subject === "string" ? args.subject.trim() : ""
    const detail = typeof args.detail === "string" && args.detail.trim() ? args.detail.trim() : ""
    if (!isTodoId(subject)) {
      return Promise.resolve({
        ok: false,
        error: `"hundredfold_action" has no tool for ${JSON.stringify(intent)} and nowhere to record it — it can only write against a Todo, and "subject" was not one. Tell the operator what is missing, and use a navigation tool to take them where they can do it themselves.`,
      })
    }
    const note = detail ? `${intent}\n\n${detail}` : intent
    return withConsent(
      { tool: "hundredfold_action", title: `Record this on ${subject}?`, hint: note, confirm: "Record it", subject },
      async () => {
        try {
          await api.addWorkItemComment(subject, note, undefined, "talk")
          return { ok: true, data: { performed: `Recorded it on ${subject}.`, subject } }
        } catch (error) {
          return writeFailed(`record that on ${subject}`, error)
        }
      },
    )
  },
}
