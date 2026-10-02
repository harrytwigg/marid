#!/usr/bin/env node
/** Deterministic, generic seed for the PLA-116 Talk driving journey. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  FIXTURE_CLOCK,
  TALK_SESSION_ID,
  TOPIC_SPECS,
  WORKFLOW_ID,
  assertDisposableHome,
  buildWorkflowDefinition,
  fixtureTopics,
  mergeById,
  topicSessionId,
} from "./talk-driving-fixture-data.mjs"

export { FIXTURE_CLOCK, TALK_SESSION_ID, assertDisposableHome, fixtureTopics, mergeById } from "./talk-driving-fixture-data.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const requireFromJinn = createRequire(path.join(repoRoot, "packages/jinn/package.json"))
const YAML = requireFromJinn("yaml")

/** @param {string[]} argv */
function parseArgs(argv) {
  const index = argv.indexOf("--home")
  if (index < 0 || !argv[index + 1]) throw new Error("--home <throwaway JINN_HOME> is required")
  return path.resolve(argv[index + 1].replace(/^~(?=$|\/)/, os.homedir()))
}

/** @param {string} home */
function readSandboxConfig(home) {
  const configPath = path.join(home, "config.yaml")
  if (!fs.existsSync(configPath)) throw new Error(`${configPath} does not exist; create the sandbox first`)
  const config = YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}
  assertDisposableHome(home, config)
  assertStopped(home)
  return { config, configPath }
}

/** @param {string} home */
function assertStopped(home) {
  const pidPath = path.join(home, "gateway.pid")
  if (!fs.existsSync(pidPath)) return
  const pid = Number(fs.readFileSync(pidPath, "utf8").trim())
  if (!Number.isInteger(pid) || pid < 1) return
  try {
    process.kill(pid, 0)
    throw new Error(`${home} has a running gateway process (${pid}); stop it before seeding`)
  } catch (error) {
    if (error instanceof Error && error.message.includes("running gateway")) throw error
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error
  }
}

/** @param {string} home */
async function loadRuntime(home) {
  process.env.JINN_HOME = home
  process.env.JINN_INSTANCE = path.basename(home).replace(/^\./, "")
  const moduleAt = (relative) => import(pathToFileURL(path.join(repoRoot, "packages/jinn/dist/src", relative)).href)
  const [db, todos, comments, relations, approvals, sessions, workflowRepo, workflowDb, talkSessions, topics, proactive, policy, tools] = await Promise.all([
    moduleAt("shared/db.js"), moduleAt("work-items/store.js"), moduleAt("work-items/comments.js"),
    moduleAt("work-items/relations.js"), moduleAt("work-items/approvals.js"), moduleAt("sessions/registry.js"),
    moduleAt("workflows/repository.js"), moduleAt("workflows/repository-migrations.js"),
    moduleAt("talk/session/repository.js"), moduleAt("talk/topics/repository.js"),
    moduleAt("talk/proactive/repository.js"), moduleAt("talk/proactive/policy.js"), moduleAt("talk/session/tools.js"),
  ])
  return { db, todos, comments, relations, approvals, sessions, workflowRepo, workflowDb, talkSessions, topics, proactive, policy, tools }
}

/** @param {string} home @param {Record<string, any>} config @param {string} configPath */
function seedFiles(home, config, configPath) {
  config.portal = { ...(config.portal ?? {}), companyName: "Sandbox Company", companyPrefix: "SBX",
    portalName: "Sandbox Gateway", operatorName: "Operator", onboarded: true, setupComplete: true }
  fs.writeFileSync(configPath, YAML.stringify(config))
  seedOrg(home)
  seedCron(home)
  seedNote(home)
}

/** @param {string} home */
function seedOrg(home) {
  const directory = path.join(home, "org", "sandbox")
  fs.mkdirSync(directory, { recursive: true })
  const employees = [
    ["sandbox-coordinator", "Sandbox Coordinator", "manager", "Coordinate local-only fixture work and route decisions."],
    ["sandbox-builder", "Sandbox Builder", "senior", "Implement generic local fixture tasks and report visible evidence."],
    ["sandbox-reviewer", "Sandbox Reviewer", "senior", "Review sandbox evidence independently and keep external systems untouched."],
  ]
  for (const [name, displayName, rank, persona] of employees) {
    fs.writeFileSync(path.join(directory, `${name}.yaml`), YAML.stringify({
      name, displayName, department: "platform", rank, engine: "codex", model: "gpt-5.5",
      ...(name === "sandbox-coordinator" ? {} : { reportsTo: "sandbox-coordinator" }), persona,
    }))
  }
}

/** @param {string} home */
function seedCron(home) {
  const file = path.join(home, "cron", "jobs.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let current = []
  try { current = JSON.parse(fs.readFileSync(file, "utf8")) } catch { current = [] }
  const owned = [
    { id: "sandbox-quiet-review", name: "Sandbox Quiet Review", enabled: false, schedule: "0 9 * * 1",
      employee: "sandbox-reviewer", prompt: "Review generic sandbox evidence without contacting external systems." },
    { id: "sandbox-urgent-drill", name: "Sandbox Urgent Drill", enabled: false, schedule: "0 12 1 * *",
      employee: "sandbox-coordinator", prompt: "Exercise the local urgent-cue fixture. Do not deliver outside this sandbox." },
  ]
  fs.writeFileSync(file, `${JSON.stringify(mergeById(current, owned), null, 2)}\n`)
}

/** @param {string} home */
function seedNote(home) {
  const file = path.join(home, "knowledge", "talk-driving-journey.md")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `---\nname: Talk driving journey\ndescription: Generic constraints for the local Talk fixture\ntype: project\n---\n\n# Talk driving journey\n\n- Every action stays inside this disposable sandbox.\n- The workflow approval remains pending until the exact operator decision.\n- Visual fallback is bounded to the workflow canvas and excludes the Talk orb.\n- Quiet cues stay silent; urgent active-topic cues may speak once.\n`)
}

/** @param {ReturnType<typeof loadRuntime> extends Promise<infer T> ? T : never} runtime */
function seedTodos(runtime) {
  const create = (input) => createOrReuseTodo(runtime, { department: "platform", source: "session", createdBy: "operator", ...input })
  const blocker = create({ title: "Confirm sandbox access window", body: "Confirm the local-only window before the checklist can resume.", status: "assigned", assignee: "sandbox-coordinator", sourceRef: "pla-116-fixture:access-window", acceptance: "A visible comment names the confirmed sandbox window." })
  const blocked = create({ title: "Publish sandbox release checklist", body: "Blocked by the access-window dependency; no external release is allowed.", status: "blocked", assignee: "sandbox-builder", sourceRef: "pla-116-fixture:blocked-release", acceptance: "The blocker, linked chat, and verification result are visible." })
  const delegated = create({ title: "Collect responsive Talk evidence", body: "Capture desktop/mobile and light/dark evidence in the sandbox.", status: "executing", assignee: "sandbox-builder", sourceRef: "pla-116-fixture:delegated-qa", acceptance: "Four UI states are recorded without private data." })
  const approval = create({ title: "Approve one sandbox-only workflow run", body: "One exact operator decision may advance the local workflow; all ambiguous input fails closed.", status: "in_review", assignee: "sandbox-reviewer", sourceRef: "pla-116-fixture:approval", acceptance: "One approval is audited and every invalid variant leaves state unchanged." })
  runtime.relations.addRelation(blocker.id, blocked.id, "blocks", "operator")
  runtime.comments.addComment({ workItemId: blocked.id, author: "sandbox-builder", authorKind: "employee",
    body: "Waiting for the confirmed sandbox access window; the linked chat contains the verification plan.", idempotencyKey: "pla-116-fixture:blocked-comment" })
  runtime.comments.addComment({ workItemId: delegated.id, author: "operator", authorKind: "operator",
    body: "Show each successful voice action in the real sandbox UI.", idempotencyKey: "pla-116-fixture:delegated-comment" })
  runtime.approvals.requestApproval(approval.id, { request: "Approve exactly one sandbox-only workflow run.",
    ref: "pla-116-fixture:operator-approval", operatorOnly: true, actor: "sandbox-reviewer" })
  return { blocked: blocked.id, blocker: blocker.id, delegated: delegated.id, approval: approval.id }
}

/** @param {any} runtime @param {Record<string, any>} input */
function createOrReuseTodo(runtime, input) {
  const row = runtime.db.initDb().prepare("SELECT id FROM work_items WHERE source = ? AND source_ref = ?")
    .get(input.source, input.sourceRef)
  return row ? runtime.todos.getWorkItem(row.id) : runtime.todos.createWorkItem(input)
}

/** @param {any} database @param {Record<string, string>} todoIds */
function seedChats(database, todoIds) {
  const insertSession = database.prepare(`INSERT INTO sessions
    (id, engine, source, source_ref, connector, session_key, employee, model, title, prompt_excerpt,
     status, total_cost, total_turns, last_context_tokens, created_at, last_activity, work_item_id)
    VALUES (?, 'codex', 'web', ?, 'web', ?, ?, 'gpt-5.5', ?, ?, 'idle', ?, 2, 1200, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, prompt_excerpt=excluded.prompt_excerpt,
      last_activity=excluded.last_activity, work_item_id=excluded.work_item_id`)
  const insertMessage = database.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp)
    VALUES (?, ?, ?, ?, ?)`)
  const workItems = [todoIds.blocked, todoIds.blocker, todoIds.delegated, null, todoIds.approval, ...Array(6).fill(null)]
  database.transaction(() => TOPIC_SPECS.forEach((topic, index) => {
    const id = topicSessionId(index + 1)
    const at = FIXTURE_CLOCK + index * 60_000
    database.prepare("DELETE FROM messages WHERE session_id = ?").run(id)
    insertSession.run(id, `sandbox:${id}`, `sandbox:${id}`, index < 3 ? "sandbox-builder" : null,
      `Talk fixture · ${topic[2]}`, topic[3], (index + 1) / 100, new Date(at).toISOString(), new Date(at + 2_000).toISOString(), workItems[index])
    insertMessage.run(`${id}-user`, id, "user", `Topic ${index + 1}: ${topic[3]}`, at)
    insertMessage.run(`${id}-assistant`, id, "assistant",
      `Verified state: ${topic[2]}. Decision: keep this local to the sandbox. Open question: what changed after this checkpoint?`, at + 1_000)
  }))()
}

/** @param {any} runtime @param {string} home @param {string} approvalTodoId */
function seedWorkflow(runtime, home, approvalTodoId) {
  fs.mkdirSync(path.join(home, "workflows"), { recursive: true })
  const db = runtime.workflowDb.openWorkflowDatabase(path.join(home, "workflows", "workflows.db"))
  const repository = new runtime.workflowRepo.WorkflowRepository(db, () => new Date(FIXTURE_CLOCK).toISOString())
  let definition = repository.getDefinition(WORKFLOW_ID)
  if (!definition) {
    const created = repository.createDefinition({ id: WORKFLOW_ID, title: "Sandbox approval flow", description: "A local graph with one exact operator gate." })
    definition = repository.saveDefinition(buildWorkflowDefinition(created), created.revision)
    definition = repository.setEnabled(definition.id, true, definition.revision)
  }
  let run = repository.findRunByIdempotency(WORKFLOW_ID, "pla-116-fixture:approval-run")
  if (!run) {
    run = repository.createRun({ workflowId: WORKFLOW_ID, input: { scope: "sandbox-only" },
      trigger: { nodeId: "start", kind: "manual", payload: { source: "fixture" }, todoId: approvalTodoId },
      idempotencyKey: "pla-116-fixture:approval-run" })
    repository.mutateRun(run.id, run.revision, (tx) => parkWorkflowAtApproval(tx))
    run = repository.getRun(WORKFLOW_ID, run.id)
  }
  db.close()
  return { workflowId: WORKFLOW_ID, runId: run.id }
}

/** @param {any} tx */
function parkWorkflowAtApproval(tx) {
  const stamp = new Date(FIXTURE_CLOCK).toISOString()
  tx.setRunStatus("waiting")
  tx.setNodeStatus("start", "completed", { activated: true, startedAt: stamp, endedAt: stamp })
  tx.setNodeStatus("prepare", "completed", { activated: true, startedAt: stamp, endedAt: stamp,
    output: { text: "Local evidence is ready.", fields: { scope: "sandbox-only" } } })
  tx.setNodeStatus("approval", "waiting", { activated: true, startedAt: stamp })
  tx.putApproval({ nodeId: "approval", status: "pending", requestedAt: stamp, approverRef: "operator" })
}

/** @param {any} runtime @param {any} database @param {{ todoIds: Record<string, string>, workflowId: string, workflowRunId: string }} refs */
function seedTalk(runtime, database, refs) {
  const talk = new runtime.talkSessions.TalkSessionRepository(database)
  talk.save({ id: TALK_SESSION_ID, browserInstanceId: "talk-fixture-browser", credentialGeneration: 2,
    sessionId: topicSessionId(1), state: "parked", model: "sandbox-realtime", brief: "Generic sandbox Talk driving journey.",
    openedAt: FIXTURE_CLOCK, lastSeenAt: FIXTURE_CLOCK + 20_000,
    turns: [{ at: FIXTURE_CLOCK + 10_000, text: "Remember the twelve local topics and return to the first after cooling.", estimatedTokens: 24 }],
    truncatedTurns: 0, tokenExpiresAt: Math.floor(FIXTURE_CLOCK / 1_000) + 3_600,
    exposedTools: runtime.tools.allTools().map(({ name }) => name), actions: [], visualReceiptKeys: [] })
  const topics = new runtime.topics.TalkTopicRepository(database)
  topics.replaceSession(TALK_SESSION_ID, fixtureTopics(refs))
  topics.saveNavigation({ talkSessionId: TALK_SESSION_ID, currentTopicId: "talk-topic-01-blocked-release",
    history: fixtureTopics(refs).map(({ id }) => id), lastCandidateIds: ["talk-topic-03-delegated-qa", "talk-topic-10-proactive"],
    credentialGeneration: 2, screenRevision: 12, updatedAt: FIXTURE_CLOCK + 30_000 })
  seedProactive(runtime, database)
}

/** @param {any} runtime @param {any} database */
function seedProactive(runtime, database) {
  const repository = new runtime.proactive.TalkProactiveRepository(database)
  const signals = [
    { eventId: "fixture-routine", dedupeKey: "blocked-release-progress", talkSessionId: TALK_SESSION_ID,
      topicId: "talk-topic-01-blocked-release", source: "todo", subjectId: "blocked-release", severity: "info",
      blocking: false, requiresOperator: false, summary: "Routine sandbox progress is ready.", uiEffect: { kind: "refresh", route: "/todos" }, occurredAt: FIXTURE_CLOCK + 40_000 },
    { eventId: "fixture-urgent", dedupeKey: "blocked-release-operator", talkSessionId: TALK_SESSION_ID,
      topicId: "talk-topic-01-blocked-release", source: "todo", subjectId: "blocked-release", severity: "critical",
      blocking: true, requiresOperator: true, summary: "The active sandbox blocker needs the operator.", uiEffect: { kind: "navigate", route: "/todos" }, occurredAt: FIXTURE_CLOCK + 50_000 },
  ]
  let spokenAt = null
  for (const [index, signal] of signals.entries()) {
    const now = FIXTURE_CLOCK + 60_000 + index * 10_000
    const decision = runtime.policy.decideProactiveDisposition(signal, { activeTopicId: "talk-topic-01-blocked-release",
      knownTopicIds: fixtureTopics({ todoIds: { blocked: "x", blocker: "y", delegated: "z", approval: "a" }, workflowId: WORKFLOW_ID, workflowRunId: "run" }).map(({ id }) => id),
      lastSpokenAt: spokenAt, now })
    const claim = repository.claim(signal, decision, now, 5_000, 3)
    if (claim.kind === "deliver") {
      const delivered = repository.markDelivered(claim.receipt.id, now + 100)
      if (delivered.disposition === "spoken") spokenAt = delivered.deliveredAt
    }
  }
}

/** @param {string} home @param {Record<string, unknown>} manifest */
function writeManifest(home, manifest) {
  const directory = path.join(home, "sandbox-artifacts")
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "pla-116-fixture.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** @param {string} home */
export async function prepareSandbox(home) {
  const { config, configPath } = readSandboxConfig(home)
  const runtime = await loadRuntime(home)
  seedFiles(home, config, configPath)
  const database = runtime.db.initDb()
  const todoIds = seedTodos(runtime)
  seedChats(database, todoIds)
  runtime.todos.linkSession(todoIds.blocked, topicSessionId(1))
  const workflow = seedWorkflow(runtime, home, todoIds.approval)
  seedTalk(runtime, database, { todoIds, workflowId: workflow.workflowId, workflowRunId: workflow.runId })
  const manifest = { fixture: "PLA-116", clock: new Date(FIXTURE_CLOCK).toISOString(), talkSessionId: TALK_SESSION_ID,
    topicSessionIds: TOPIC_SPECS.map((_, index) => topicSessionId(index + 1)), todoIds, workflow,
    notePath: "knowledge/talk-driving-journey.md", cronIds: ["sandbox-quiet-review", "sandbox-urgent-drill"] }
  writeManifest(home, manifest)
  runtime.db.__closeDbForTest()
  return manifest
}

async function main() {
  const manifest = await prepareSandbox(parseArgs(process.argv))
  console.log(JSON.stringify(manifest, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
}
