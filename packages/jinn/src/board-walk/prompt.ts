import type { BoardWalkSettings } from "./settings.js";
import type { CapacitySnapshot } from "./snapshot.js";

/**
 * The walk's prompt: the task and how to use the walk's tools, the facts the
 * board cannot give (the time and the capacity snapshot), and the one part
 * the operator writes: the body of board-walk.md, quoted as the rules.
 *
 * The board itself is not in the prompt. The model reads it through its
 * tools, one Todo at a time, and hands over one decision per Todo
 * (mcp/board-walk-tools.ts, turn.ts), so the prompt stays the same size
 * however big the board grows.
 */

const HOW_TO_WALK = `## How to walk the board

Your only tools are these five; there are no others in this turn.

- \`walk_board\` lists the open Todos, one line each, highest priority first, with what this tick has already decided. Page through it with \`offset\`.
- \`walk_todo\` shows one Todo in full: its facts, relations, the real state of linked GitHub pull requests and issues, its body and its newest comments. Read a Todo in full before you release, park or flag it, or start it.
- \`walk_decide\` hands over your decision on one Todo, with your reason. The gateway checks it and carries it out at once, and answers with what it did. A refused decision changes nothing, and you may decide that Todo again.
- \`walk_start\` starts one backlog Todo through the Todo Dispatcher, with why this one, now.
- \`walk_finish\`, once and last: a one-sentence summary, and why you started what you started or why you started nothing.

Go through every open Todo and make one decision on each. "leave" is a decision: use it, with your verdict and reason, for a Todo with nothing to do now. A Todo that plainly has nothing to decide (one being worked on, say) can be left from its board line without reading it in full.

Decide on starts last, across the whole board: the capacity rules are about the board as a whole, so settle every Todo first, then start what the rules and the snapshot allow, then finish.

Independent calls may go in one message: reading or deciding several Todos at once is faster and costs less. This tick allows at most {{maxCalls}} tool calls; past that the gateway refuses every call, and whatever is not decided waits for the next tick.

The decisions:

- Each has a verdict (ready, gated, stuck or unclear) and an action (release, park, flag or leave).
- "release" moves a blocked Todo back to backlog. It must list in \`gates\` every gate that is now met, and the gateway checks each one itself: a date gate's \`quote\` must be the Todo's own words that contain the date itself (as "2026-11-01", "1 November" or "Nov 1"), copied exactly, and the date must have passed; a blocker must be done and named by this Todo; a pull request linked from this Todo must have merged, or an issue closed. Your own earlier comments do not count as the Todo's words. A release whose gates cannot be checked is refused, so a Todo waiting on a person's decision is flagged, not released.
- "park" moves a backlog or blocked Todo to blocked until \`until\` (ISO-8601), after which the gateway re-queues it by itself.
- "flag" comments once that the Todo looks stuck.
- Only use ids the board gives you. Never invent a Todo, a date or a pull request state.
- If a gate depends on something the Todo does not show, the verdict is "unclear": leave it and say what is missing.`;

function switches(settings: BoardWalkSettings): string {
  const off = Object.entries(settings.actions).filter(([, on]) => !on).map(([name]) => name);
  return off.length === 0
    ? "Every action is switched on."
    : `These actions are switched OFF and the gateway will refuse them: ${off.join(", ")}. Do not use them.`;
}

function defaultsSection(defaults: string[]): string[] {
  if (defaults.length === 0) return [];
  return [
    "",
    "## Shipped defaults for the sections the operator's file leaves out",
    "",
    "These apply because the operator's file has no section of the same name. Anything the operator's rules above say wins over them, including a rule not to do something.",
    "",
    ...defaults.map((section) => section.replace(/^## /m, "### Default: ")),
  ];
}

export function buildPrompt(input: {
  settings: BoardWalkSettings;
  rules: string;
  defaults?: string[];
  snapshot: CapacitySnapshot;
  board: { open: number; inReview: number };
  maxCalls: number;
}): string {
  const { settings, rules, snapshot, board } = input;
  return [
    "You are running the board walk: a scheduled pass over this company's Todo board.",
    "You go through the open Todos one at a time and decide on each, following the operator's rules below, then decide whether to start any of them.",
    "You do not act: your tools hand each decision to the gateway, which checks it and carries it out.",
    "",
    `It is now ${snapshot.now} (UTC); local time is ${snapshot.localTime}, ${snapshot.weekday}, in ${snapshot.timezone}.`,
    `The board has ${board.open} open Todo${board.open === 1 ? "" : "s"}; ${board.inReview} more ${board.inReview === 1 ? "is" : "are"} in review, which is the operator's desk and not yours to touch.`,
    switches(settings),
    "",
    "## The operator's rules (board-walk.md)",
    "",
    rules || "(The operator's file has no body of its own.)",
    ...defaultsSection(input.defaults ?? []),
    "",
    "## Capacity snapshot",
    "",
    "Readings are live; a `prediction` is drawn from the retained readings and is an estimate, not a reading.",
    "`startedThisWindow` counts sessions started on that engine in its current five-hour window, by what started them",
    "(your own walk turns are not counted): `board-walk-dispatch` is a Todo Dispatcher the board walk started, so those are your starts;",
    "`dispatch` is one started by hand; the rest are chats, cron, delegations and captures.",
    "",
    "```json",
    JSON.stringify(snapshot, null, 1),
    "```",
    "",
    HOW_TO_WALK.replace("{{maxCalls}}", String(input.maxCalls)),
  ].join("\n");
}
