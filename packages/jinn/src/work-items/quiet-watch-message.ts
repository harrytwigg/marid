import type { SessionDeliveryPayload } from "../shared/types.js";
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

function minutesSince(since: number, now: number): number {
  return Math.max(1, Math.round((now - since) / 60_000));
}

export interface QuietNudgeInput {
  item: Pick<WorkItem, "id" | "title">;
  quietSince: number;
  now: number;
  /** The session still counts a background shell task it started. */
  awaitingBackgroundTask: boolean;
}

export function quietNudgePayload(input: QuietNudgeInput): SessionDeliveryPayload {
  const { item, quietSince, now } = input;
  const minutes = minutesSince(quietSince, now);
  const waited = input.awaitingBackgroundTask
    ? `This session still counts a background command it started, but it has been running for over ${minutes} minutes with no word. `
      + "Check it directly: if it is done, read its result; if it is stuck, stop it and run it again in the foreground."
    : "If you ended your turn waiting on a background command, test run or build, it has finished or was lost, "
      + "and its notification will not wake you. Check its result directly now.";
  const message = [
    `[Gateway] Todo ${item.id} (${clip(item.title, DISPLAY_TITLE_MAX_CHARS)}) is still \`executing\`, `
      + `but nothing has run in this session for ${minutes} minutes.`,
    waited,
    "Then carry on with the work. If you are waiting on a person, move the Todo to `blocked` with a note saying who "
      + "and what. If the work is finished, hand it in the way your brief says. Do not end another turn waiting on "
      + "something that cannot wake you.",
  ].join("\n\n");
  return {
    message,
    displayMessage: `⏸ ${item.id} quiet for ${minutes} min: asked to carry on`,
    meta: { kind: "todo-quiet-nudge", workItemId: item.id },
  };
}

export interface QuietEscalationInput {
  item: Pick<WorkItem, "id" | "title" | "assignee">;
  /** The producer session that went quiet. */
  sessionId: string | undefined;
  quietSince: number;
  nudgedAt: number | undefined;
  now: number;
}

function nudgeLine(input: QuietEscalationInput): string {
  if (input.nudgedAt === undefined) return "No session of it could be messaged, so it was not nudged.";
  const at = new Date(input.nudgedAt).toISOString();
  return `The gateway nudged it at ${at} to carry on, and it has gone quiet again.`;
}

function actionLine(input: QuietEscalationInput): string {
  const read = input.sessionId ? `read_session { sessionId: "${input.sessionId}", last: 20 } to see where it stopped, then ` : "";
  return `Look at it now: ${read}nudge it with send_to_session, re-dispatch it with dispatch_work_item, `
    + "or take the work back. If it is waiting on a person, it should be `blocked` with a note.";
}

export function quietEscalationPayload(input: QuietEscalationInput): SessionDeliveryPayload {
  const { item, quietSince, now } = input;
  const who = item.assignee ? `, ${item.assignee}` : "";
  const message = [
    `[Gateway] Todo ${item.id} (${clip(item.title, DISPLAY_TITLE_MAX_CHARS)}${who}) has been \`executing\` `
      + `with nothing running for ${minutesSince(quietSince, now)} minutes`
      + `${input.sessionId ? ` (session ${input.sessionId})` : ""}.`,
    nudgeLine(input),
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
