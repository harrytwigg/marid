/**
 * The authoritative catalog of what Talk may execute.
 *
 * Domains that grow own their own entries (`todo-operations.ts`) and the company
 * inventory owns itself (`capability-coverage.ts`); what is left here is the
 * assembly, the parity check that keeps the inventory honest, and the lookup.
 */
import { BROWSER_CONTROL_OPERATIONS } from "./browser-tools.js";
import { gateway, integer, params, string } from "./operation-builders.js";
import { TODO_GATEWAY_OPERATIONS } from "./todo-operations.js";
import {
  TALK_COMPANY_CAPABILITY_COVERAGE,
  type TalkCompanyCapabilityCoverage,
} from "./capability-coverage.js";
import type { TalkControlManifest, TalkControlOperation } from "./types.js";

export { TALK_COMPANY_CAPABILITY_COVERAGE, renderTalkCompanyCoverageMarkdown } from "./capability-coverage.js";
export type { TalkCompanyCapabilityCoverage } from "./capability-coverage.js";

const GATEWAY_OPERATIONS: readonly TalkControlOperation[] = [
  gateway("prepare_voice_approval", "Prepare a short-lived approval challenge for one Todo. This never decides it.", params({ id: string("The full Todo id.") }, ["id"]), "todos", { mutability: "write", verification: "approval-challenge-reread" }),
  gateway("commit_voice_approval", "Commit a prepared challenge from the separately recorded final operator utterance. Arguments contain only the challenge id.", params({ challengeId: string("The prepared challenge id.") }, ["challengeId"]), "todos", { mutability: "write", verification: "approval-decision-reread" }),
  gateway("talk_delegate_todo", "Delegate an existing Todo to a named employee and open its resulting chat.", params({
    id: string("The full Todo id."),
    employee: string("The employee slug."),
    task: string("The full delegation brief."),
  }, ["id", "employee"]), "delegation", { mutability: "write", verification: "todo-session-link-reread" }),
  gateway("read_session", "Read one chat session and its recent messages from the authoritative store. Use this before answering about a chat's state or history, including the one on screen, whose id is on the 'Selected session id' line of the page context.", params({ id: string("The session id.") }, ["id"]), "sessions", { mutability: "read", verification: "session-reread" }),
  gateway("talk_send_to_session", "Send a message into a chat session, named or not currently visible. Use this whenever the operator asks to message the chat they are looking at: the page context names its id on the 'Selected session id' line.", params({
    id: string("The session id, copied from the 'Selected session id' line of the page context when the operator means the chat on screen."),
    message: string("The operator message."),
  }, ["id", "message"]), "sessions", { mutability: "write", verification: "session-message-reread" }),
  gateway("talk_start_workflow_run", "Start one enabled manual Workflow run.", params({ id: string("The workflow id."), input: string("Optional JSON object input.") }, ["id"]), "workflows", { mutability: "write", verification: "workflow-run-reread" }),
  gateway("read_workflow_runs", "Read recent runs of one Workflow.", params({ id: string("The workflow id."), limit: integer("Maximum runs to return.") }, ["id"]), "workflows", { mutability: "read", verification: "workflow-runs-reread" }),
  gateway("read_workflow_run", "Read one exact Workflow run.", params({ id: string("The workflow id."), runId: string("The run id.") }, ["id", "runId"]), "workflows", { mutability: "read", verification: "workflow-run-reread" }),
  gateway("talk_recall_topic", "Resolve a vague reference to an earlier Talk topic. Returns candidates instead of guessing when ambiguous.", params({ reference: string("The operator's reference, such as 'the first one' or 'the release workflow'.") }, ["reference"]), "memory", { mutability: "read", verification: "topic-resolution-reread" }),
  gateway("talk_remember_topic", "Save an explicit goal, decision, or unresolved question on the current Talk topic.", params({
    topicId: string("Optional exact topic id; omit to use the current topic."),
    goal: string("The durable goal."),
    decision: string("One durable decision."),
    unresolvedQuestion: string("One open question."),
    resolvedQuestion: string("An exact open question that is now resolved."),
  }), "memory", { mutability: "write", verification: "topic-commitment-reread" }),
  gateway("read_talk_capability", "Read whether a company capability is supported or return its exact named gap and planned adapter. Known lanes include todos, chats, workflows, notes, cron, org, skills, settings, logs, files, instances, approvals, topics, and screen navigation.", params({
    capability: string("The exact capability key from the Talk company inventory."),
  }, ["capability"]), "capabilities", { mutability: "read", verification: "capability-inventory-reread" }),
];

const MANIFEST: TalkControlManifest = {
  version: 1,
  operations: [...TODO_GATEWAY_OPERATIONS, ...GATEWAY_OPERATIONS, ...BROWSER_CONTROL_OPERATIONS],
};

/** Every supported entry must name operations the manifest actually declares,
 *  and every gap must say what it is and what it needs. */
export function validateTalkCompanyCoverage(
  manifest: TalkControlManifest = MANIFEST,
  coverage: Readonly<Record<string, TalkCompanyCapabilityCoverage>> = TALK_COMPANY_CAPABILITY_COVERAGE,
): string[] {
  const declared = new Set(manifest.operations.map((operation) => operation.name));
  return Object.entries(coverage).flatMap(([capability, entry]) => {
    if (entry.status === "explicit-gap") {
      return entry.reason && entry.plannedAdapter ? [] : [`incomplete explicit gap: ${capability}`];
    }
    if (!entry.operations.length || !entry.evidence) return [`incomplete supported capability: ${capability}`];
    return entry.operations.filter((operation) => !declared.has(operation))
      .map((operation) => `unknown manifest operation for ${capability}: ${operation}`);
  });
}

/** Return a detached public copy so callers cannot mutate the process catalog. */
export function buildTalkControlManifest(): TalkControlManifest {
  return structuredClone(MANIFEST);
}

export function operationByName(manifest: TalkControlManifest, name: string): TalkControlOperation | undefined {
  return manifest.operations.find((operation) => operation.name === name);
}
