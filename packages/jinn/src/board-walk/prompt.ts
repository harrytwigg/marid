import type { BoardWalkSettings } from "./settings.js";
import type { CapacitySnapshot } from "./snapshot.js";
import { fitBoard, type BoardDigest } from "./board.js";

/**
 * The walk's one prompt. Three parts the operator does not write — the task,
 * the answer format, and the facts (capacity snapshot and board) — around the
 * one part they do: the body of board-walk.md, quoted as the rules.
 *
 * The answer format is the contract with decisions.ts. The model is told it
 * does not act and must not call tools: the gateway carries the answer out, so
 * a tool call here would be an act nobody checked.
 */

/**
 * The whole prompt's size, in bytes of UTF-8. The board gets whatever the
 * rest leaves. The prompt is the walk turn's message, and Claude Code takes the
 * message as one command-line argument, which Linux caps at 131,071 bytes; this
 * keeps a quarter of that spare. Size is also the cost of every tick.
 */
export const PROMPT_BUDGET_BYTES = 96_000;

const ANSWER_FORMAT = `Answer with exactly one JSON object in a \`\`\`json fenced block, and nothing after it:

\`\`\`json
{
  "todos": [
    { "id": "<Todo id>", "verdict": "ready | gated | stuck | unclear", "action": "release | park | flag | none",
      "reason": "<one or two plain sentences>", "until": "<ISO-8601, only for park>",
      "gates": [ { "kind": "date", "date": "<YYYY-MM-DD>", "quote": "<the Todo's own words naming the date>" } | { "kind": "blocker", "id": "<Todo id>" } | { "kind": "pr" | "issue", "url": "<GitHub URL>" } ] }
  ],
  "dispatch": {
    "start": [ { "id": "<backlog Todo id>", "reason": "<why this one, now>", "engine": "<optional preference>", "model": "<optional preference>" } ],
    "reason": "<why you are starting these, or why you are starting nothing — always required>"
  },
  "summary": "<one sentence: what this tick came to>"
}
\`\`\`

- List every Todo you release, park or flag, and every Todo you judge gated, stuck or unclear (action "none" when you leave it). A backlog Todo with no gate and nothing to say may be left out.
- "release" moves a blocked Todo back to backlog. It must list in "gates" every gate that is now met, and the gateway checks each one itself: a date gate's "quote" must be the Todo's own words that contain the date itself (as "2026-11-01", "1 November" or "Nov 1"), copied exactly, and the date must have passed; a blocker must be done and named by this Todo; a pull request linked from this Todo must have merged, or an issue closed. Your own earlier comments do not count as the Todo's words. A release whose gates cannot be checked is refused, so a Todo waiting on a person's decision is flagged, not released. "park" moves a backlog or blocked Todo to blocked until "until", after which the gateway re-queues it by itself. "flag" comments once that the Todo looks stuck.
- Only use ids from the board below. Never invent a Todo, a date or a pull request state.
- If a gate depends on something the board does not show, the verdict is "unclear": leave the Todo alone and say what is missing.
- dispatch.start may be empty; dispatch.reason is required either way.`;

function switches(settings: BoardWalkSettings): string {
  const off = Object.entries(settings.actions).filter(([, on]) => !on).map(([name]) => name);
  return off.length === 0
    ? "Every action is switched on."
    : `These actions are switched OFF and the gateway will refuse them: ${off.join(", ")}. Do not propose them.`;
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

function boardHeading(board: BoardDigest, shown: number): string {
  const notShown = board.omitted + (board.todos.length - shown);
  return `## The board (${shown} open Todo${shown === 1 ? "" : "s"}${notShown > 0 ? `, ${notShown} more not shown` : ""}; ${board.inReview} in review, not yours to touch)`;
}

const BOARD_LEGEND = [
  "Each Todo is a `### <id>: <title>` heading followed by one line per fact. Times are UTC.",
  "Priority runs from 0 to 3, and 3 is the highest. A `no auto-start` line means the Todo refuses automatic starts: never start it.",
  "`already flagged stuck` means you already flagged this episode. `link` lines carry the real state of linked GitHub pull requests and issues.",
  "The body and the newest comments are the Todo's own words, indented; long ones are cut short and say so.",
];

export function buildPrompt(input: { settings: BoardWalkSettings; rules: string; defaults?: string[]; snapshot: CapacitySnapshot; board: BoardDigest; budgetBytes?: number }): string {
  const { settings, rules, snapshot, board } = input;
  const head = [
    "You are running the board walk: a scheduled pass over this company's Todo board.",
    "You decide which Todos are ready and whether to start any of them, following the operator's rules below.",
    "You do not act, and this turn has no tools: everything you need is below. The gateway reads your answer, checks it, and carries it out.",
    "",
    `It is now ${snapshot.now} (UTC); local time is ${snapshot.localTime}, ${snapshot.weekday}, in ${snapshot.timezone}.`,
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
  ].join("\n");
  const tail = ["", "## Your answer", "", ANSWER_FORMAT].join("\n");
  const legend = ["", ...BOARD_LEGEND, ""].join("\n");
  // The heading's counts are not known until the board is fitted, so room is
  // reserved for the longest it can be.
  const fixed = [head, boardHeading(board, board.todos.length), legend, tail].reduce((sum, part) => sum + Buffer.byteLength(part, "utf8") + 1, 0);
  const fitted = fitBoard(board.todos, (input.budgetBytes ?? PROMPT_BUDGET_BYTES) - fixed);
  return [head, boardHeading(board, fitted.shown.length), legend, fitted.text, tail].join("\n");
}
