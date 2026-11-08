import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const EVIDENCE = fileURLToPath(new URL("../deliverable-evidence.mjs", import.meta.url))

/** realpath because macOS hands out a symlinked temp root, and `write` compares
 *  a resolved path against the home it was given. */
function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function run(...args) {
  const result = spawnSync(process.execPath, [EVIDENCE, ...args], { encoding: "utf8" })
  assert.notEqual(result.status, null, `the script was killed by ${result.signal}`)
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

/** A workspace home holding one delivered file, plus the manifest path beside it. */
function fixture(body = "# a Note the verifier will never read\n") {
  const home = tmp("evidence-home-")
  const repo = tmp("evidence-repo-")
  fs.writeFileSync(path.join(home, "note.md"), body)
  return { home, repo, manifest: path.join(repo, ".jinn-build", "deliverable-evidence.json") }
}

function writeManifest(manifest, value) {
  fs.mkdirSync(path.dirname(manifest), { recursive: true })
  fs.writeFileSync(manifest, typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

const VALID = {
  todoId: "AAA-802",
  summary: "one Note delivered into the workspace",
  entries: [{ path: "note.md", sha256: "a".repeat(64), bytes: 12 }],
}

test("write records a sha256 equal to shasum -a 256 of the delivered file", () => {
  const { home, manifest } = fixture()
  const written = run("write", "--todo", "AAA-802", "--home", home, "--manifest", manifest, "--summary", "a Note", "note.md")
  assert.equal(written.status, 0, written.out)

  const shasum = spawnSync("shasum", ["-a", "256", path.join(home, "note.md")], { encoding: "utf8" })
  assert.equal(shasum.status, 0, shasum.stderr)
  const expected = shasum.stdout.trim().split(/\s+/)[0]

  const record = JSON.parse(fs.readFileSync(manifest, "utf8"))
  assert.deepEqual(record.entries, [
    { path: "note.md", sha256: expected, bytes: fs.statSync(path.join(home, "note.md")).size },
  ])
  assert.equal(record.todoId, "AAA-802")
  assert.equal(record.summary, "a Note")
})

for (const [name, arg] of [
  ["a path containing ..", "../escape.md"],
  ["an absolute path outside the given home", "/etc/hosts"],
  ["a path under secrets/", "secrets/api-keys.json"],
]) {
  test(`write refuses ${name}`, () => {
    const { home, manifest } = fixture()
    const refused = run("write", "--todo", "AAA-802", "--home", home, "--manifest", manifest, "--summary", "s", arg)
    assert.notEqual(refused.status, 0, `expected a refusal, got: ${refused.out}`)
    // The refusal has to name the path it turned down; a non-zero exit alone is
    // also what a missing script produces.
    assert.ok(refused.out.includes(arg), `the refusal does not name ${arg}: ${refused.out}`)
    assert.equal(fs.existsSync(manifest), false, "a refused write must leave no manifest behind")
  })
}

test("write refuses a link whose file physically lives under secrets/", () => {
  const { home, manifest } = fixture()
  fs.mkdirSync(path.join(home, "secrets"))
  fs.writeFileSync(path.join(home, "secrets", "fake.json"), '{"token":"x"}\n')
  fs.symlinkSync(path.join(home, "secrets", "fake.json"), path.join(home, "innocent.md"))

  const refused = run("write", "--todo", "AAA-802", "--home", home, "--manifest", manifest, "--summary", "s", "innocent.md")
  assert.notEqual(refused.status, 0, `a secret was hashed through a link: ${refused.out}`)
  assert.match(refused.out, /secrets\//)
  assert.equal(fs.existsSync(manifest), false, "a refused write must leave no manifest behind")
})

test("check refuses a secrets/ entry spelled with a leading dot segment", () => {
  const { manifest } = fixture()
  writeManifest(manifest, { ...VALID, entries: [{ path: "./secrets/fake.json", sha256: "a".repeat(64), bytes: 12 }] })
  const checked = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.notEqual(checked.status, 0, `a secret passed as evidence: ${checked.out}`)
})

test("check exits 0 on a valid manifest", () => {
  const { manifest } = fixture()
  writeManifest(manifest, VALID)
  const checked = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.equal(checked.status, 0, checked.out)
})

test("check names each way a manifest can be wrong, and names them distinctly", () => {
  const cases = {
    missing: null,
    malformed: "{ not json",
    empty: { ...VALID, entries: [] },
    badHash: { ...VALID, entries: [{ path: "note.md", sha256: "abc", bytes: 12 }] },
    secrets: { ...VALID, entries: [{ path: "secrets/api-keys.json", sha256: "a".repeat(64), bytes: 12 }] },
    mismatch: { ...VALID, todoId: "AAA-101" },
  }

  const reasons = new Map()
  for (const [name, value] of Object.entries(cases)) {
    const { manifest } = fixture()
    if (value !== null) writeManifest(manifest, value)
    const checked = run("check", "--todo", "AAA-802", "--manifest", manifest)
    assert.notEqual(checked.status, 0, `${name}: expected a non-zero exit, got: ${checked.out}`)
    reasons.set(name, checked.out.trim())
  }

  assert.equal(new Set(reasons.values()).size, reasons.size, `messages repeat: ${[...reasons.values()].join(" | ")}`)
})

test("check opens no path but the manifest — a deliverable that is gone still passes", () => {
  const { manifest } = fixture()
  writeManifest(manifest, { ...VALID, entries: [{ path: "vanished/gone.md", sha256: "b".repeat(64), bytes: 7 }] })
  const checked = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.equal(checked.status, 0, `check read the deliverable instead of only the manifest: ${checked.out}`)
})

// The shape that parked a finished Todo in `blocked`: everything delivered lives
// in the workspace, the product diff is empty, and the verifier has nothing in
// the repository to rule on. Absent the manifest that is still true.
test("a workspace-only deliverable with an empty product diff reaches a verdict", () => {
  const { home, manifest } = fixture()

  const beforeTheChange = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.notEqual(beforeTheChange.status, 0, "with no evidence the verifier must not be able to rule")

  const written = run("write", "--todo", "AAA-802", "--home", home, "--manifest", manifest, "--summary", "a Note", "note.md")
  assert.equal(written.status, 0, written.out)

  const verdict = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.equal(verdict.status, 0, verdict.out)
  assert.match(verdict.out, /note\.md/)
})

/** One NUL-terminated field per record, exactly as `git diff --name-status -z`
 *  writes it: a status, then its path, or its two paths for a rename. */
function diff(...fields) {
  return fields.map((field) => `${field}\0`).join("")
}

function route(stream, ...args) {
  const result = spawnSync(process.execPath, [EVIDENCE, "route", ...args], {
    input: Buffer.from(stream, "utf8"),
    encoding: "utf8",
  })
  assert.notEqual(result.status, null, `the script was killed by ${result.signal}`)
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

const DOCS_ONLY = diff("M", "docs/architecture.md", "A", ".jinn-build/notes.json")
const TOUCHES_SOURCE = diff("M", "docs/architecture.md", "M", "packages/gateway/src/server.ts")

test("route honours a workspace declaration when the diff is empty or non-shipping", () => {
  for (const stream of ["", DOCS_ONLY]) {
    const routed = route(stream, "--declared", "workspace")
    assert.equal(routed.status, 0, `a diff of ${JSON.stringify(stream)} is not shipping: ${routed.out}`)
  }
})

test("route counts the paths in the stream and not the statuses beside them", () => {
  const routed = route(diff("M", "docs/architecture.md", "A", "docs/new.md"), "--declared", "workspace")
  assert.equal(routed.status, 0, `a status was judged as a shipping path: ${routed.out}`)
  assert.ok(routed.out.includes("2 changed paths"), `the statuses were counted as paths: ${routed.out}`)
})

test("route refuses a workspace declaration whose diff touches a shipping path", () => {
  const routed = route(TOUCHES_SOURCE, "--declared", "workspace")
  // Distinct from `fail`, so the pipeline can tell a false declaration apart
  // from a mistyped call.
  assert.equal(routed.status, 2, `expected the route-mismatch exit, got ${routed.status}: ${routed.out}`)
  assert.ok(routed.out.includes("packages/gateway/src/server.ts"), `the refusal does not name the offending file: ${routed.out}`)
})

test("route names every offending file, not just the first", () => {
  const offenders = ["packages/gateway/src/server.ts", "scripts/check-footguns.mjs", "package.json"]
  const stream = diff("M", "docs/architecture.md", ...offenders.flatMap((offender) => ["M", offender]))
  const routed = route(stream, "--declared", "workspace")
  assert.equal(routed.status, 2, routed.out)
  for (const offender of offenders) {
    assert.ok(routed.out.includes(offender), `${offender} is not named: ${routed.out}`)
  }
})

test("route treats a top-level directory it has never heard of as shipping", () => {
  const routed = route(diff("A", "brand-new-top-level/thing.ts"), "--declared", "workspace")
  assert.equal(routed.status, 2, `an unknown top-level directory was let through as non-shipping: ${routed.out}`)
})

test("route judges a path by the file it names, not by how it is spelled", () => {
  const routed = route(diff("M", "./packages/gateway/src/server.ts"), "--declared", "workspace")
  assert.equal(routed.status, 2, `a leading dot segment slipped past the shipping check: ${routed.out}`)
})

test("route judges both sides of a rename, so moving source under docs/ does not hide it", () => {
  // Under `--name-only` this diff read as `docs/ship.ts` alone and the false
  // declaration was honoured, while the diff was still removing source.
  const routed = route(diff("R100", "packages/demo/ship.ts", "docs/ship.ts"), "--declared", "workspace")
  assert.equal(routed.status, 2, `a rename out of packages/ slipped past the shipping check: ${routed.out}`)
  // Named as the path it is, not as the raw record it arrived in: the pipeline
  // reads these lines back to the operator.
  assert.match(routed.out, /^ {2}packages\/demo\/ship\.ts$/m, `the refusal does not name the file the rename removed: ${routed.out}`)
})

// The class that a whitespace-splitting parse let through. Each of these is a
// shipping diff that a false `workspace` declaration must not carry past code
// review, and each was read as something else when the fields were guessed
// apart instead of separated by the one byte a filename cannot hold.
for (const [name, changed] of [
  ["is spelled like a status letter", "M"],
  ["is top-level and contains a space", "M docs/notes.md"],
  ["contains a space", "packages/demo/a b.ts"],
  ["is not ASCII", "packages/demo/café.ts"],
]) {
  test(`route refuses a shipping path that ${name}`, () => {
    const routed = route(diff("M", changed), "--declared", "workspace")
    assert.equal(routed.status, 2, `a shipping path was let through as workspace: ${routed.out}`)
    assert.match(
      routed.out,
      new RegExp(`^ {2}${changed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
      `the refusal does not name the path whole: ${routed.out}`,
    )
    // `-z` writes paths raw, so nothing arrives in git's `"caf\303\251"` form
    // and nothing has to be unescaped before the operator reads it.
    assert.doesNotMatch(routed.out, /\\3[0-7]{2}/, `the path was reported in git's escaped form: ${routed.out}`)
  })
}

test("route fails loudly on a malformed stream rather than reporting an empty diff", () => {
  const malformed = {
    "an unrecognised status": diff("nonsense", "packages/gateway/src/server.ts"),
    "a status with no path behind it": diff("M", "docs/architecture.md", "M"),
    // Git scores a rename or copy always and a rewrite at its option, and nothing
    // else. A score taken on any letter read `A100` as an added file and honoured
    // the declaration over a diff nobody had judged.
    "a score on a status git never scores": diff("A100", "docs/architecture.md"),
    "a rename missing the score git always writes": diff("R", "packages/demo/ship.ts", "docs/ship.ts"),
    // The score is a percentage, so 100 is the top of it. Read unbounded, any
    // three digits were a score and `R999` was a status, which put the same
    // unjudged diff behind a stream git could not have written.
    "a rename scored past a percentage": diff("R999", "docs/old.md", "docs/new.md"),
    "a rewrite scored past a percentage": diff("M999", "docs/architecture.md"),
    "a copy scored one past a percentage": diff("C101", "docs/a.md", "docs/b.md"),
  }
  for (const [name, stream] of Object.entries(malformed)) {
    const routed = route(stream, "--declared", "workspace")
    // Exit 1, not the mismatch 2: the stream is unreadable, so there is no
    // declaration to rule on. Silence here is the bypass.
    assert.equal(routed.status, 1, `${name}: expected a usage failure, got ${routed.status}: ${routed.out}`)
    assert.doesNotMatch(routed.out, /changed path/, `${name}: an unreadable stream was reported as a diff: ${routed.out}`)
  }
})

test("route still reads a score at the top of the percentage", () => {
  // 100 is inside the bound, so a rewrite git scored whole is an ordinary status
  // and its path is judged. `R100` is guarded by the rename test above.
  const routed = route(diff("M100", "docs/architecture.md"), "--declared", "workspace")
  assert.equal(routed.status, 0, `a score git does write was read as malformed: ${routed.out}`)
})

test("route reads the diff on stdin and refuses it as arguments", () => {
  // The argv form split on whitespace, which is what let a path named `M` or a
  // path with a space through. Leaving that door open would leave the class open.
  const routed = route("", "--declared", "workspace", "packages/gateway/src/server.ts")
  assert.notEqual(routed.status, 0, `positional paths were still parsed: ${routed.out}`)
  assert.match(routed.out, /--name-status -z/, `the refusal does not name the piped form: ${routed.out}`)
})

test("route lets the repo declaration through whatever the stream holds", () => {
  for (const stream of [DOCS_ONLY, TOUCHES_SOURCE]) {
    const routed = route(stream, "--declared", "repo")
    assert.equal(routed.status, 0, `the ordinary route must not be blocked: ${routed.out}`)
  }
})

test("route refuses a --declared value that is neither repo nor workspace", () => {
  const missing = route(DOCS_ONLY)
  assert.equal(missing.status, 1, `expected a usage failure, got ${missing.status}: ${missing.out}`)

  const nonsense = route(DOCS_ONLY, "--declared", "workspaces")
  assert.equal(nonsense.status, 1, `expected a usage failure, got ${nonsense.status}: ${nonsense.out}`)
  assert.match(nonsense.out, /usage:/)
})
