import assert from "node:assert/strict"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { assertIsolatedLayout, assertRepresentativeStateSurvived, buildMinimalEnvironment, createLabRoot, removeLabRoot } from "../run.mjs"
import { assertWorkflowSkillRetired } from "../workflow-state.mjs"
import { EXTERNAL_WAIT_CEILING_MS, external } from "./external-ceilings.mjs"

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex")

test("state probing reads a Workflow module only when the package ships one", () => {
  const probe = fs.readFileSync(path.resolve("scripts/upgrade-lab/state-probe.mjs"), "utf8")
  assert.match(probe, /query-candidate/)
  assert.match(probe, /workflows\/repository-migrations\.js/)
  assert.match(probe, /legacy-v1-import-report\.json/)
  assert.match(probe, /hasWorkflowRepository/)
  assert.match(probe, /storage: "none"/)
})

function writeProbeHome(layout) {
  fs.mkdirSync(path.join(layout.home, "org", "lab"), { recursive: true })
  fs.writeFileSync(
    path.join(layout.home, "org", "lab", "operator.yaml"),
    "name: lab-operator\ndisplayName: Lab Operator\ndepartment: lab\nrank: employee\nengine: codex\npersona: Disposable fixture.\n",
  )
}

function runProbe(mode, packageRoot, layout, env) {
  const probe = path.resolve("scripts/upgrade-lab/state-probe.mjs")
  const evidenceRoot = path.join(layout.home, "workflow-evidence")
  const result = spawnSync(process.execPath, [probe, mode, packageRoot, evidenceRoot], {
    env, encoding: "utf8", timeout: EXTERNAL_WAIT_CEILING_MS,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

/** The built package with a stand-in Workflow module, so the probe sees a baseline that still ships one. */
function writeWorkflowBearingPackage(root) {
  const sourceModules = path.resolve("packages/jinn/dist/src")
  const modules = path.join(root, "dist", "src")
  fs.mkdirSync(path.join(modules, "workflows"), { recursive: true })
  for (const entry of fs.readdirSync(sourceModules)) fs.symlinkSync(path.join(sourceModules, entry), path.join(modules, entry))
  const sqlite = pathToFileURL(path.resolve("packages/jinn/package.json")).href
  fs.writeFileSync(path.join(modules, "workflows", "repository-migrations.js"), `
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
const Database = createRequire(${JSON.stringify(sqlite)})("better-sqlite3")
export function openWorkflowDatabase() {
  const file = path.join(process.env.JINN_HOME, "workflows", "workflows.db")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const database = new Database(file)
  database.exec("CREATE TABLE IF NOT EXISTS workflow_definitions (id TEXT PRIMARY KEY, title TEXT, revision INTEGER, enabled INTEGER)")
  return database
}
`)
  fs.writeFileSync(path.join(modules, "workflows", "repository.js"), `
export class WorkflowRepository {
  constructor(database) { this.database = database }
  getDefinition(id) { return this.database.prepare("SELECT * FROM workflow_definitions WHERE id = ?").get(id) }
  createDefinition({ id, title }) { this.database.prepare("INSERT INTO workflow_definitions VALUES (?, ?, 1, 0)").run(id, title) }
}
`)
  return root
}

test("state probing records a non-module snapshot when the package ships no Workflow module", external, () => {
  const root = createLabRoot()
  try {
    const layout = assertIsolatedLayout(root)
    writeProbeHome(layout)
    const env = buildMinimalEnvironment(layout, { PATH: process.env.PATH ?? "" })
    const packageRoot = path.resolve("packages/jinn")

    const seeded = runProbe("seed-old", packageRoot, layout, env)
    assert.deepEqual(seeded.workflow, { storage: "none" })
    assert.deepEqual(seeded.workflowsDb, { exists: false, sha256: null })
    assert.equal(fs.existsSync(path.join(layout.home, "workflows")), false)

    const bytes = Buffer.from("workflow data left by an earlier package")
    fs.mkdirSync(path.join(layout.home, "workflows"))
    fs.writeFileSync(path.join(layout.home, "workflows", "workflows.db"), bytes)
    const queried = runProbe("query-candidate", packageRoot, layout, env)
    assert.deepEqual(queried.workflow, { storage: "none" })
    assert.deepEqual(queried.workflowsDb, { exists: true, sha256: sha256(bytes) })
    assert.deepEqual(fs.readFileSync(path.join(layout.home, "workflows", "workflows.db")), bytes)
  } finally {
    removeLabRoot(root)
  }
})

test("state probing seeds a Workflow only through a package that ships the module and leaves its database untouched when reading", external, () => {
  const root = createLabRoot()
  try {
    const layout = assertIsolatedLayout(root)
    writeProbeHome(layout)
    const env = buildMinimalEnvironment(layout, { PATH: process.env.PATH ?? "" })
    const baselineRoot = writeWorkflowBearingPackage(path.join(root, "baseline-package"))
    const candidateRoot = path.resolve("packages/jinn")
    const database = path.join(layout.home, "workflows", "workflows.db")

    const seeded = runProbe("seed-old", baselineRoot, layout, env)
    assert.deepEqual(seeded.workflow, {
      count: 1,
      id: "upgrade-lab-workflow",
      title: "Upgrade lab representative workflow",
      revision: 1,
      enabled: false,
      storage: "v2",
    })
    assert.equal(seeded.workflowsDb.exists, true)

    const left = sha256(fs.readFileSync(database))
    const before = runProbe("query-old", baselineRoot, layout, env)
    assert.equal(before.workflowsDb.sha256, left)
    assert.equal(sha256(fs.readFileSync(database)), left, "reading the baseline must not rewrite its database")

    const after = runProbe("query-candidate", candidateRoot, layout, env)
    assert.deepEqual(after.workflow, { storage: "none" })
    assert.doesNotThrow(() => assertRepresentativeStateSurvived(before, after))

    fs.appendFileSync(database, "rewritten")
    assert.throws(
      () => assertRepresentativeStateSurvived(before, runProbe("query-candidate", candidateRoot, layout, env)),
      /deleted or rewritten/,
    )
    fs.rmSync(database)
    assert.throws(
      () => assertRepresentativeStateSurvived(before, runProbe("query-candidate", candidateRoot, layout, env)),
      /deleted or rewritten/,
    )
  } finally {
    removeLabRoot(root)
  }
})

test("a candidate without a Workflow module must leave the baseline's workflows.db as it found it", () => {
  const base = {
    session: { count: 1, id: "session-id", sessionKey: "upgrade-lab:state", title: "Lab state" },
    todo: { count: 1, id: "todo-id", sourceRef: "upgrade-lab:todo", title: "Lab Todo", status: "backlog" },
    cron: { count: 1, id: "upgrade-lab-cron", prompt: "fixture" },
    org: { count: 1, name: "lab-operator", persona: "Disposable fixture." },
  }
  const seeded = { count: 1, id: "workflow-id", title: "Upgrade lab Workflow", revision: 1, enabled: false, storage: "v2" }
  const before = { ...structuredClone(base), workflow: seeded, workflowsDb: { exists: true, sha256: "aaa" } }
  const after = (workflowsDb) => ({ ...structuredClone(base), workflow: { storage: "none" }, workflowsDb })

  assert.doesNotThrow(() => assertRepresentativeStateSurvived(before, after({ exists: true, sha256: "aaa" })))
  assert.throws(
    () => assertRepresentativeStateSurvived(before, after({ exists: false, sha256: null })),
    /workflows\.db was deleted or rewritten/,
  )
  assert.throws(
    () => assertRepresentativeStateSurvived(before, after({ exists: true, sha256: "bbb" })),
    /workflows\.db was deleted or rewritten/,
  )
  assert.throws(
    () => assertRepresentativeStateSurvived({ ...before, workflowsDb: { exists: false, sha256: null } }, after({ exists: false, sha256: null })),
    /baseline left no workflows\.db/,
  )
  assert.throws(
    () => assertRepresentativeStateSurvived({ ...before, workflow: { count: 0 } }, after({ exists: true, sha256: "aaa" })),
    /baseline seeded no workflow/,
  )
  assert.throws(
    () => assertRepresentativeStateSurvived({ ...before, session: { count: 0 } }, after({ exists: true, sha256: "aaa" })),
    /session.*changed/i,
  )
})

test("the retired workflow skill must be gone after the first boot, and a surviving copy is named as unmodified or modified", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-upgrade-skill-"))
  try {
    const key = "skills/workflow/SKILL.md"
    assert.doesNotThrow(() => assertWorkflowSkillRetired({ home, baselineTree: { [key]: "aaa" }, finalTree: {} }))

    fs.mkdirSync(path.join(home, "skills", "workflow"), { recursive: true })
    fs.writeFileSync(path.join(home, key), "copy")
    assert.throws(
      () => assertWorkflowSkillRetired({ home, baselineTree: { [key]: "aaa" }, finalTree: { [key]: "aaa" } }),
      /still present although it matches the baseline copy/,
    )
    assert.throws(
      () => assertWorkflowSkillRetired({ home, baselineTree: { [key]: "aaa" }, finalTree: { [key]: "bbb" } }),
      /still present because its copy was modified.*skills\/workflow\/SKILL\.md/,
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
