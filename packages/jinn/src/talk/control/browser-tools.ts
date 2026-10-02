import type { JsonObject } from "../../shared/types.js";
import type { TalkControlOperation, TalkControlParameters } from "./types.js";

const string = (description: string, values?: string[]): JsonObject => ({
  type: "string",
  description,
  ...(values ? { enum: values } : {}),
});

function params(properties: JsonObject, required: string[] = []): TalkControlParameters {
  return { type: "object", properties, required, additionalProperties: false };
}

function browser(
  name: string,
  description: string,
  parameters: TalkControlParameters,
  intent: string,
  mutability: "read" | "effect" = "effect",
): TalkControlOperation {
  return {
    name,
    description,
    parameters,
    target: "browser",
    intent,
    mutability,
    operatorOnly: false,
    verification: "browser-receipt",
  };
}

/** Browser entries are bounded to navigation, focus, current-view reads, and visual evidence. */
export const BROWSER_CONTROL_OPERATIONS: readonly TalkControlOperation[] = [
  browser("open_todos", "Open the Todo board with optional visible filters.", params({
    board: string("Board scope."),
    status: string("Todo status filter."),
    assignee: string("Assignee filter."),
    department: string("Department filter."),
    source: string("Source filter."),
    label: string("Label filter."),
    due: string("Due window filter."),
    q: string("Title search."),
  }), "todos"),
  browser("open_todo", "Open one Todo by id.", params({ id: string("The full Todo id.") }, ["id"]), "todos"),
  browser("open_chats", "Open chat or a specific session.", params({ sessionId: string("The session id.") }), "sessions"),
  browser("open_workflows", "Open Workflows or one workflow and lens.", params({
    id: string("The workflow id."),
    lens: string("The editor or runs lens.", ["editor", "runs"]),
  }), "workflows"),
  browser("focus_element", "Focus and reveal a safe visible control.", params({ target: string("The semantic control target.") }, ["target"]), "page"),
  browser("resolve_and_open", "Resolve a spoken Todo, chat, or Workflow reference and open it.", params({ what: string("The spoken reference.") }, ["what"]), "navigation"),
  browser("talk_search_chat_messages", "Search earlier messages in the chat currently on screen. Use this for questions about what was said or decided earlier. Returns matching excerpts only; speak excerpts and relative time, never identifiers.", params({
    query: string("All words to match in the current chat, at most 512 characters."),
  }, ["query"]), "sessions", "read"),
  browser("talk_draft_reply", "Fill the empty composer in the chat currently on screen. This only drafts; it never sends.", params({
    message: string("The reply text, at most 8000 characters."),
  }, ["message"]), "sessions"),
  browser("talk_replace_draft", "Replace the existing visible chat draft. This only edits; it never sends.", params({
    message: string("The replacement reply text, at most 8000 characters."),
  }, ["message"]), "sessions"),
  browser("talk_send_draft", "Send exactly the text currently visible in the selected chat composer, once and without another confirmation.", params({}), "sessions"),
  browser("talk_draft_and_send", "Atomically draft and send one reply in the chat currently on screen. Use only for an explicit draft-and-send request.", params({
    message: string("The reply text, at most 8000 characters."),
  }, ["message"]), "sessions"),
  browser("capture_current_view", "Capture one bounded image only for a declared semantic visual gap.", params({ reason: string("The declared visual-gap reason.") }, ["reason"]), "visual", "read"),
];
