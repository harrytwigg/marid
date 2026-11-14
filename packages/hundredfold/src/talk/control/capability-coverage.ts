/**
 * What Talk can actually do to the company, inventoried.
 *
 * Kept apart from the manifest on purpose: seeing a surface never implies that
 * Talk can mutate it. Supported entries name exact manifest operations — the
 * parity check in `manifest.ts` refuses a name that is not declared — and every
 * other lane carries a stable gap id and the seam it still needs, so the list
 * cannot quietly drift into a promise.
 */
import { BROWSER_CONTROL_OPERATIONS } from "./browser-tools.js";

export type TalkCompanyCapabilityCoverage =
  | { status: "supported"; operations: readonly string[]; evidence: string }
  | { status: "explicit-gap"; reason: string; plannedAdapter: string };

/**
 * Company controls are deliberately inventoried separately from route context.
 * Seeing a surface never implies that Talk can mutate it. Supported entries
 * name exact manifest operations; every other company lane has a stable gap id
 * and the canonical adapter seam it still needs.
 */
export const TALK_COMPANY_CAPABILITY_COVERAGE = {
  "todo-core": {
    status: "supported",
    operations: [
      "read_todo", "talk_create_todo", "talk_edit_todo", "talk_set_todo_status",
      "talk_comment_todo", "talk_assign_todo", "talk_delegate_todo",
    ],
    evidence: "authoritative Todo, creation, status, comment, assignment, and linked-session rereads",
  },
  "todo-extended": {
    status: "explicit-gap",
    reason: "todo-extended-command-adapter-missing",
    plannedAdapter: "reuse label, relation, attachment, and comment-delete commands; cancellation stays off the voice surface deliberately",
  },
  "chat-core": {
    status: "supported",
    operations: ["read_session", "talk_search_chat_messages", "talk_draft_reply", "talk_replace_draft", "talk_send_draft", "talk_draft_and_send", "talk_send_to_session"],
    evidence: "bounded current-chat excerpts, visible-composer receipts, and a durable named-session message re-read bound to the operator's own utterance",
  },
  "chat-lifecycle": {
    status: "explicit-gap",
    reason: "chat-lifecycle-command-adapter-missing",
    plannedAdapter: "reuse create, rename, archive, duplicate, delete, queue, stop, and reset commands",
  },
  delegation: {
    status: "supported",
    operations: ["talk_delegate_todo"],
    evidence: "Todo-to-session link, child session, and dispatch rereads",
  },
  "topic-memory": {
    status: "supported",
    operations: ["talk_recall_topic", "talk_remember_topic"],
    evidence: "durable topic commitments, candidates, navigation, and source rehydration",
  },
  "screen-navigation-and-visual": {
    status: "supported",
    operations: BROWSER_CONTROL_OPERATIONS
      .filter((operation) => !new Set([
        "talk_search_chat_messages", "talk_draft_reply", "talk_replace_draft",
        "talk_send_draft", "talk_draft_and_send",
      ]).has(operation.name))
      .map((operation) => operation.name),
    evidence: "browser receipt, awaited UI effect, or bounded sanitized visual receipt",
  },
  "capability-inventory": {
    status: "supported",
    operations: ["read_talk_capability"],
    evidence: "typed manifest-backed supported operation or exact gap id and planned adapter",
  },
  notes: {
    status: "explicit-gap",
    reason: "notes-command-adapter-missing",
    plannedAdapter: "reuse managed note list, read, create, and update commands",
  },
  cron: {
    status: "explicit-gap",
    reason: "cron-command-adapter-missing",
    plannedAdapter: "reuse cron update, enable, disable, trigger, and run-inspection commands",
  },
  org: {
    status: "explicit-gap",
    reason: "org-command-adapter-missing",
    plannedAdapter: "reuse employee read, editable-field update, delegation, and session commands",
  },
  skills: {
    status: "explicit-gap",
    reason: "skills-command-adapter-missing",
    plannedAdapter: "reuse managed skill read and update commands with exact content confirmation",
  },
  "settings-and-plugins": {
    status: "explicit-gap",
    reason: "settings-plugins-command-adapter-missing",
    plannedAdapter: "reuse safe config and guarded plugin lifecycle commands without exposing secrets",
  },
  "logs-and-limits": {
    status: "explicit-gap",
    reason: "logs-limits-command-adapter-missing",
    plannedAdapter: "reuse bounded redacted log queries and engine-limit refresh commands",
  },
  "managed-files": {
    status: "explicit-gap",
    reason: "managed-files-command-adapter-missing",
    plannedAdapter: "reuse allowed-home list, read, publish, and attach commands",
  },
  "instances-and-onboarding": {
    status: "explicit-gap",
    reason: "instance-onboarding-command-adapter-missing",
    plannedAdapter: "reuse guarded instance and onboarding commands with exact scope confirmation",
  },
  "company-read-lanes": {
    status: "explicit-gap",
    reason: "company-read-lanes-adapter-missing",
    plannedAdapter: "reuse knowledge, search, cost, connector, and heartbeat reads",
  },
} as const satisfies Readonly<Record<string, TalkCompanyCapabilityCoverage>>;

export function renderTalkCompanyCoverageMarkdown(
  coverage: Readonly<Record<string, TalkCompanyCapabilityCoverage>> = TALK_COMPANY_CAPABILITY_COVERAGE,
): string {
  const rows = Object.entries(coverage).map(([capability, entry]) => entry.status === "supported"
    ? `| ${capability} | supported | ${entry.operations.join(", ")} | ${entry.evidence} |`
    : `| ${capability} | explicit gap | — | ${entry.reason}; ${entry.plannedAdapter} |`);
  return [
    "## Company capability inventory",
    "",
    "> Generated from `TALK_COMPANY_CAPABILITY_COVERAGE`. A semantic route never implies mutation authority.",
    "",
    "| Capability | Status | Manifest operations | Verification or planned seam |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
