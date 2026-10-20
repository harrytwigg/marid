import type { SessionDeliveryPayload } from "../shared/types.js";
import type { ChildWork } from "./quiet-children.js";
import type { WorkItem } from "./store.js";

/**
 * What the quiet-Todo watch says. The producer's nudge tells it why nothing will
 * wake it and what to do instead; the escalation tells whoever owns the work
 * from above which session went quiet and what they can do about it.
 */

const DISPLAY_TITLE_MAX_CHARS = 120;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

function minutesSince(since: number, now: number): string {
  const minutes = Math.max(1, Math.round((now - since) / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export interface QuietNudgeInput {
  item: Pick<WorkItem, "id" | "title">;
  quietSince: number;
  now: number;
  /** The session still counts a background shell task it started. */
  awaitingBackgroundTask: boolean;
  /** Its children waiting on it, which the nudge names instead of a lost background command. */
  children?: Pick<ChildWork, "settled" | "notStarting">;
}

/** What the Todo's children need from it, or undefined when none does. */
function childrenLine(children: QuietNudgeInput["children"]): string | undefined {
  if (!children || (children.settled.length === 0 && children.notStarting.length === 0)) return undefined;
  const parts: string[] = [];
  if (children.settled.length > 0) {
    parts.push(`Its child Todos ${children.settled.map((child) => `${child.id} (${child.status})`).join(", ")} have been handed back and wait on you: `
      + "accept or send back a review, unblock or re-plan a blocked one.");
  }
  if (children.notStarting.length > 0) {
    parts.push(`Its child Todos ${children.notStarting.join(", ")} are in backlog where the board walk will not start them `
      + "(automatic start is off, or they are the operator's): dispatch them, start them yourself, or drop them from the plan.");
  }
  return parts.join(" ");
}

function waitedLine(input: QuietNudgeInput, minutes: string): string {
  const children = childrenLine(input.children);
  if (children) return children;
  return input.awaitingBackgroundTask
    ? `This session still counts a background command it started, but it has been running for over ${minutes} with no word. `
      + "Check it directly: if it is done, read its result; if it is stuck, stop it and run it again in the foreground."
    : "If you ended your turn waiting on a background command, test run or build, it has finished or was lost, "
      + "and its notification will not wake you. Check its result directly now.";
}

export function quietNudgePayload(input: QuietNudgeInput): SessionDeliveryPayload {
  const { item, quietSince, now } = input;
  const minutes = minutesSince(quietSince, now);
  const waited = waitedLine(input, minutes);
  const message = [
    `[Gateway] Todo ${item.id} (${clip(item.title, DISPLAY_TITLE_MAX_CHARS)}) is still \`executing\`, `
      + `but nothing has run in this session for ${minutes}.`,
    waited,
    "Then carry on with the work. If you are waiting on a person, move the Todo to `blocked` with a note saying who "
      + "and what. If the work is finished, hand it in the way your brief says. Do not end another turn waiting on "
      + "something that cannot wake you.",
  ].join("\n\n");
  return {
    message,
    displayMessage: `⏸ ${item.id} quiet for ${minutes}: asked to carry on`,
    meta: { kind: "todo-quiet-nudge", workItemId: item.id },
  };
}

export interface QuietEscalationInput {
  item: Pick<WorkItem, "id" | "title" | "assignee">;
  /** The producer session that went quiet. */
  sessionId: string | undefined;
  quietSince: number;
  nudgedAt: number | undefined;
  /** A session of the assignee can be messaged now. */
  reachable: boolean;
  now: number;
}

function quietLine(input: QuietEscalationInput): string {
  const { quietSince, now } = input;
  if (input.nudgedAt === undefined) {
    return `Nothing has run for it for ${minutesSince(quietSince, now)}, and none of its assignee's sessions `
      + "can be messaged, so it was not nudged.";
  }
  return `The gateway nudged its session at ${new Date(input.nudgedAt).toISOString()} to carry on, `
    + `and nothing has run since for ${minutesSince(quietSince, now)}.`;
}

/** Only what works on a Todo in this state: a dispatch is refused while the
 *  assignee's session is idle between turns, so it is offered only when no
 *  session of the assignee can be messaged now (one may have errored since the
 *  nudge). */
function actionLine(input: QuietEscalationInput): string {
  const read = input.sessionId ? `read_session { sessionId: "${input.sessionId}", last: 20 } to see where it stopped, then ` : "";
  const act = !input.reachable
    ? "re-dispatch it with dispatch_work_item, or take the work back or reassign it"
    : "message it with send_to_session, or take the work back or reassign it";
  return `Look at it now: ${read}${act}. If it is waiting on a person, it should be \`blocked\` with a note.`;
}

export function quietEscalationPayload(input: QuietEscalationInput): SessionDeliveryPayload {
  const { item } = input;
  const who = item.assignee ? `, ${item.assignee}` : "";
  const message = [
    `[Gateway] Todo ${item.id} (${clip(item.title, DISPLAY_TITLE_MAX_CHARS)}${who}) is \`executing\` with nothing running`
      + `${input.sessionId ? ` (session ${input.sessionId})` : ""}.`,
    quietLine(input),
    actionLine(input),
  ].join("\n\n");
  return {
    message,
    displayMessage: `⚠️ ${item.id} stalled: quiet after a nudge`,
    meta: { kind: "todo-quiet-escalation", workItemId: item.id, ...(input.sessionId ? { childSessionId: input.sessionId } : {}) },
  };
}

/** The same escalation as the reason a parent is re-dispatched with. */
export function quietEscalationReason(input: QuietEscalationInput): string {
  return `A child Todo stalled. ${quietEscalationPayload(input).message.replace(/^\[Gateway\] /, "")}`;
}
