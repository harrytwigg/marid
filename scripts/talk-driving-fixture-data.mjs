import os from "node:os"
import path from "node:path"

export const FIXTURE_CLOCK = Date.parse("2026-08-18T09:00:00.000Z")
export const TALK_SESSION_ID = "talk-fixture-session"
const PROTECTED_PORTS = new Set([7777, 7788])

const TOPIC_STATES = ["active", "warm", "warm", "warm", ...Array(5).fill("cool")]

export const TOPIC_SPECS = [
  ["blocked-release", "todo", "Blocked release checklist", "Explain the blocker and open its linked chat."],
  ["access-window", "todo", "Access window dependency", "Confirm what must finish before the release can resume."],
  ["delegated-qa", "chat", "Delegated QA evidence", "Inspect the delegated chat and its visible evidence."],
  ["note", "other", "Launch constraints note", "Retrieve the durable sandbox-only constraints."],
  ["cron", "other", "Quiet review schedule", "Inspect the disabled recurring review without enabling it."],
  ["org", "other", "Sandbox platform team", "Identify the generic owner and reviewer."],
  ["settings", "other", "Safe sandbox settings", "Verify onboarding state without credentials or external connectors."],
  ["proactive", "chat", "Proactive cue policy", "Distinguish a quiet routine cue from one urgent spoken cue."],
  ["resilience", "chat", "Retry and interruption evidence", "Confirm dedupe and interruption state survive a cold reload."],
]

/** @param {number} number */
export function topicSessionId(number) {
  return `talk-fixture-topic-${String(number).padStart(2, "0")}`
}

/** @param {{ todoIds: Record<string, string> }} refs */
export function fixtureTopics(refs) {
  const anchors = topicAnchors(refs)
  return TOPIC_SPECS.map(([slug, kind, label, goal], index) => ({
    id: `talk-topic-${String(index + 1).padStart(2, "0")}-${slug}`,
    talkSessionId: TALK_SESSION_ID,
    ordinal: index + 1,
    kind,
    state: TOPIC_STATES[index],
    label,
    objectAnchors: anchors[index],
    goal,
    verifiedState: `Seeded fixture state ${index + 1} is available in the local sandbox UI.`,
    decisions: [`Keep topic ${index + 1} sandbox-only and verify every write in the UI.`],
    unresolvedQuestions: [`What changed in ${label.toLowerCase()} after the last verified state?`],
    retrievalAnchors: [slug, label.toLowerCase(), `topic ${index + 1}`],
    rawDetails: [`Deterministic fixture evidence for ${label}.`],
    transient: false,
    createdAt: FIXTURE_CLOCK + index * 1_000,
    updatedAt: FIXTURE_CLOCK + index * 1_000,
    closedAt: null,
    revision: 1,
  }))
}

/** @param {{ todoIds: Record<string, string> }} refs */
function topicAnchors(refs) {
  const chat = (number) => [{ kind: "chat", id: topicSessionId(number), label: `Topic ${number} chat` }]
  return [
    [{ kind: "todo", id: refs.todoIds.blocked, relation: "subject" }, ...chat(1)],
    [{ kind: "todo", id: refs.todoIds.blocker, relation: "blocks" }, ...chat(2)],
    [{ kind: "todo", id: refs.todoIds.delegated, relation: "subject" }, ...chat(3)],
    [{ kind: "note", id: "talk-driving-journey", relation: "subject" }, ...chat(4)],
    [{ kind: "cron", id: "sandbox-quiet-review", relation: "subject" }, ...chat(5)],
    [{ kind: "employee", id: "sandbox-coordinator", relation: "owner" }, ...chat(6)],
    [{ kind: "settings", id: "portal", relation: "subject" }, ...chat(7)],
    [{ kind: "proactive-policy", id: "routine-and-urgent", relation: "subject" }, ...chat(8)],
    [{ kind: "resilience", id: "dedupe-and-barge-in", relation: "subject" }, ...chat(9)],
  ]
}

/** @template {{ id: string }} T @param {T[]} existing @param {T[]} owned */
export function mergeById(existing, owned) {
  const replacements = new Map(owned.map((item) => [item.id, item]))
  const merged = existing.map((item) => replacements.get(item.id) ?? item)
  const existingIds = new Set(existing.map(({ id }) => id))
  return [...merged, ...owned.filter(({ id }) => !existingIds.has(id))]
}

/** @param {string} home @param {{ gateway?: { port?: number } }} config */
export function assertDisposableHome(home, config) {
  if (path.resolve(home) === path.join(os.homedir(), ".jinn") || path.basename(home) === ".jinn") {
    throw new Error(`${home} is the production instance home; use a throwaway sandbox home`)
  }
  const port = config.gateway?.port
  if (typeof port === "number" && PROTECTED_PORTS.has(port)) {
    throw new Error(`${home} uses protected gateway port ${port}; refusing to seed it`)
  }
}
