import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  buildVitestArgs,
  diffRuns,
  formatFlakySummary,
  readReport,
  selectFailedFiles,
  toRetryFilter,
  withLeasedWorkers,
} from "../vitest-flaky-retry.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.resolve(here, "../vitest-flaky-retry.mjs")
const fixtureDir = path.join(here, "fixtures", "vitest-flaky-retry")

// The captured reports were sanitised to this synthetic package root so no real
// home path ships in a fixture.
const FIXTURE_PACKAGE_DIR = "/repo/packages/example"

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8")
}

function fixtureReport(name) {
  return JSON.parse(fixture(name))
}

/** One failed suite in `file`, its assertions given as `[name, status]` pairs. */
function failedSuiteReport(packageDir, file, message, assertions) {
  const assertionResults = assertions.map(([fullName, status]) => ({ fullName, status }))
  return { testResults: [{ name: `${packageDir}/${file}`, status: "failed", message, assertionResults }] }
}

test("outside CI the args are a bare vitest run with the passthrough", () => {
  const args = buildVitestArgs({ passthrough: ["--maxWorkers=2", "--testTimeout=30000"] })

  assert.deepEqual(args, ["run", "--maxWorkers=2", "--testTimeout=30000"])
})

test("a report path adds the JSON reporter, and retry files come before the passthrough", () => {
  const args = buildVitestArgs({
    passthrough: ["--maxWorkers=2"],
    files: ["src/a.test.ts"],
    reportPath: "/tmp/run-1.json",
  })

  assert.deepEqual(args, [
    "run",
    "src/a.test.ts",
    "--maxWorkers=2",
    "--reporter=default",
    "--reporter=json",
    "--outputFile.json=/tmp/run-1.json",
  ])
})

test("a Windows report name becomes a package-relative forward-slash filter", () => {
  assert.equal(
    toRetryFilter("C:\\repo\\packages\\example\\src\\nested\\a.test.ts", "C:\\repo\\packages\\example"),
    "src/nested/a.test.ts",
  )
})

test("a name outside the package falls back to the whole forward-slash path", () => {
  assert.equal(
    toRetryFilter("D:\\elsewhere\\a.test.ts", "C:\\repo\\packages\\example"),
    "D:/elsewhere/a.test.ts",
  )
})

test("hook and collection failures are selected even though they report no failed test", () => {
  const selected = selectFailedFiles(fixtureReport("run1-failed.json"), FIXTURE_PACKAGE_DIR)

  assert.deepEqual(
    selected.map((entry) => entry.file),
    ["src/assertfail.test.ts", "src/collectfail.test.ts", "src/hookfail.test.ts"],
  )
  assert.deepEqual(selected[0].failedTests, ["fails an assertion"])
  assert.deepEqual(selected[1].failedTests, [])
  assert.equal(selected[1].message, "boom at collection")
  assert.deepEqual(selected[2].failedTests, [])
  assert.equal(selected[2].message, "boom in hook")
})

test("everything that failed first and passed on the rerun is flaky, and nothing still fails", () => {
  const { flaky, stillFailing } = diffRuns(
    fixtureReport("run1-failed.json"),
    fixtureReport("run2-passed.json"),
    FIXTURE_PACKAGE_DIR,
  )

  assert.deepEqual(
    flaky.map((entry) => ({ file: entry.file, tests: entry.tests })),
    [
      { file: "src/assertfail.test.ts", tests: ["fails an assertion"] },
      { file: "src/collectfail.test.ts", tests: [] },
      { file: "src/hookfail.test.ts", tests: [] },
    ],
  )
  assert.deepEqual(stillFailing, [])
})

test("a failure that repeats on the rerun is still failing and is never called flaky", () => {
  const { flaky, stillFailing } = diffRuns(
    fixtureReport("run1-failed.json"),
    fixtureReport("run1-failed.json"),
    FIXTURE_PACKAGE_DIR,
  )

  assert.deepEqual(flaky, [])
  assert.deepEqual(
    stillFailing.map((entry) => ({ file: entry.file, tests: entry.tests })),
    [
      { file: "src/assertfail.test.ts", tests: ["fails an assertion"] },
      { file: "src/collectfail.test.ts", tests: [] },
      { file: "src/hookfail.test.ts", tests: [] },
    ],
  )
})

test("a file whose retry suite still failed is never flaky, even when one test recovered", () => {
  const run = (recovers) =>
    failedSuiteReport(FIXTURE_PACKAGE_DIR, "src/mixed.test.ts", "", [
      ["recovers", recovers],
      ["always broken", "failed"],
    ])

  const { flaky, stillFailing } = diffRuns(run("failed"), run("passed"), FIXTURE_PACKAGE_DIR)

  assert.deepEqual(flaky, [])
  assert.deepEqual(stillFailing, [
    { file: "src/mixed.test.ts", tests: ["always broken"], message: "" },
  ])
  assert.doesNotMatch(formatFlakySummary(flaky), /mixed\.test\.ts/)
})

test("a test the rerun merely skipped is not treated as recovered", () => {
  const hookFail = (message, status) =>
    failedSuiteReport(FIXTURE_PACKAGE_DIR, "src/hookfail.test.ts", message, [["sometimes runs", status]])

  const { flaky, stillFailing } = diffRuns(
    hookFail("", "failed"),
    hookFail("boom in hook", "skipped"),
    FIXTURE_PACKAGE_DIR,
  )

  assert.deepEqual(flaky, [])
  assert.deepEqual(stillFailing[0].tests, ["sometimes runs"])
})

test("a missing or unparseable report reads as no report at all", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaky-report-"))
  const garbage = path.join(dir, "garbage.json")
  const wrongShape = path.join(dir, "wrong-shape.json")
  fs.writeFileSync(garbage, "not json at all")
  fs.writeFileSync(wrongShape, JSON.stringify({ ok: true }))

  try {
    assert.equal(readReport(path.join(dir, "absent.json")), null)
    assert.equal(readReport(garbage), null)
    assert.equal(readReport(wrongShape), null)
    assert.notEqual(readReport(path.join(fixtureDir, "run1-failed.json")), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the job-summary markdown names every flaky file and test", () => {
  const { flaky } = diffRuns(
    fixtureReport("run1-failed.json"),
    fixtureReport("run2-passed.json"),
    FIXTURE_PACKAGE_DIR,
  )

  const markdown = formatFlakySummary(flaky)

  assert.match(markdown, /## ⚠ FLAKY/)
  assert.match(markdown, /- `src\/assertfail\.test\.ts`\n {2}- fails an assertion/)
  assert.match(markdown, /- `src\/collectfail\.test\.ts`\n {2}- whole file: boom at collection/)
  assert.match(markdown, /- `src\/hookfail\.test\.ts`\n {2}- whole file: boom in hook/)
})

/**
 * The end-to-end tests below drive the real script against a stub `vitest` so
 * the invocation count, the added flags and the exit code are observed rather
 * than assumed. The failure mode of this whole wrapper is a silent green, and a
 * test over the pure helpers alone cannot catch that.
 */
function stubPackage(t, buildPlan) {
  // realpath, because on macOS os.tmpdir() is a symlink and the child's
  // process.cwd() would report the resolved path the fixture does not carry.
  const pkgDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flaky-pkg-")))
  t.after(() => fs.rmSync(pkgDir, { recursive: true, force: true }))

  const vitestDir = path.join(pkgDir, "node_modules", "vitest")
  fs.mkdirSync(vitestDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "stub-package" }))
  fs.writeFileSync(
    path.join(vitestDir, "package.json"),
    JSON.stringify({ name: "vitest", version: "0.0.0", bin: { vitest: "./vitest.mjs" } }),
  )
  fs.writeFileSync(
    path.join(vitestDir, "vitest.mjs"),
    `import fs from "node:fs"
const calls = fs.existsSync(process.env.STUB_LOG)
  ? JSON.parse(fs.readFileSync(process.env.STUB_LOG, "utf8"))
  : []
const plan = JSON.parse(fs.readFileSync(process.env.STUB_PLAN, "utf8"))
const step = plan[calls.length]
const args = process.argv.slice(2)
calls.push(args)
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify(calls))
const outputFlag = args.find((arg) => arg.startsWith("--outputFile.json="))
if (outputFlag && step.report !== undefined) {
  fs.writeFileSync(outputFlag.slice("--outputFile.json=".length), step.report)
}
process.exit(step.exit)
`,
  )

  const planPath = path.join(pkgDir, "plan.json")
  const logPath = path.join(pkgDir, "calls.json")
  // Pre-created and empty, so "nothing was appended" is an observation rather
  // than the absence of a file that may never have been reachable.
  const summaryPath = path.join(pkgDir, "summary.md")
  fs.writeFileSync(summaryPath, "")
  fs.writeFileSync(planPath, JSON.stringify(buildPlan(pkgDir)))

  return { pkgDir, planPath, logPath, summaryPath }
}

/** Repoints a captured fixture at the stub package so the filters come out relative to it. */
function reportFor(pkgDir, name) {
  return fixture(name).split(FIXTURE_PACKAGE_DIR).join(pkgDir.replaceAll("\\", "/"))
}

function retryOnceThenPass(pkgDir) {
  return [
    { exit: 1, report: reportFor(pkgDir, "run1-failed.json") },
    { exit: 0, report: reportFor(pkgDir, "run2-passed.json") },
  ]
}

/** Both runs fail the suite; only the second one gets one of its two assertions to pass. */
function retryRecoversOneAssertion(pkgDir) {
  const run = (recovers) =>
    failedSuiteReport(pkgDir.replaceAll("\\", "/"), "src/mixed.test.ts", "one assertion still fails", [
      ["recovers", recovers],
      ["always broken", "failed"],
    ])
  return ["failed", "passed"].map((recovers) => ({ exit: 1, report: JSON.stringify(run(recovers)) }))
}

function runWrapper({ pkgDir, planPath, logPath, summaryPath }, extraEnv) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, JINN_TEST_GLOBAL_CORES: "0", STUB_PLAN: planPath, STUB_LOG: logPath }
  delete env.CI
  delete env.GITHUB_STEP_SUMMARY
  Object.assign(env, extraEnv)

  const result = spawnSync(process.execPath, [scriptPath, "--maxWorkers=2"], {
    cwd: pkgDir,
    env,
    encoding: "utf8",
  })
  const calls = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : []
  const summary = fs.readFileSync(summaryPath, "utf8")

  return { ...result, calls, summary }
}

test("outside CI it runs vitest once, adds nothing, and exits with its code", (t) => {
  const stub = stubPackage(t, () => [{ exit: 3 }])

  const run = runWrapper(stub, {})

  assert.equal(run.status, 3)
  assert.deepEqual(run.calls, [["run", "--maxWorkers=2"]])
  assert.equal(run.summary, "")
})

test("a green CI run stays quiet: one invocation, exit 0, no FLAKY, no summary", (t) => {
  const stub = stubPackage(t, () => [{ exit: 0, report: JSON.stringify({ testResults: [] }) }])

  const run = runWrapper(stub, { CI: "true", GITHUB_STEP_SUMMARY: stub.summaryPath })

  assert.equal(run.status, 0)
  assert.equal(run.calls.length, 1)
  assert.doesNotMatch(run.stdout, /FLAKY/)
  assert.equal(run.summary, "")
})

test("a failure that passes on the rerun exits 0, prints FLAKY, and writes the job summary", (t) => {
  const stub = stubPackage(t, retryOnceThenPass)

  const run = runWrapper(stub, { CI: "true", GITHUB_STEP_SUMMARY: stub.summaryPath })

  assert.equal(run.status, 0)
  assert.equal(run.calls.length, 2)
  assert.deepEqual(run.calls[1].slice(0, 4), [
    "run",
    "src/assertfail.test.ts",
    "src/collectfail.test.ts",
    "src/hookfail.test.ts",
  ])
  assert.match(run.stdout, /⚠ FLAKY/)
  assert.match(run.stdout, /fails an assertion/)
  assert.match(run.stdout, /A flake is a bug to fix, not noise to ignore\./)
  assert.match(run.stdout, /::warning file=.*::FLAKY/)
  assert.match(run.summary, /## ⚠ FLAKY/)
  assert.match(run.summary, /src\/hookfail\.test\.ts/)
})

test("a failure that repeats stays red and is reported as still failing, not flaky", (t) => {
  const stub = stubPackage(t, (pkgDir) => [
    { exit: 1, report: reportFor(pkgDir, "run1-failed.json") },
    { exit: 1, report: reportFor(pkgDir, "run1-failed.json") },
  ])

  const run = runWrapper(stub, { CI: "true", GITHUB_STEP_SUMMARY: stub.summaryPath })

  assert.equal(run.status, 1)
  assert.equal(run.calls.length, 2)
  assert.match(run.stdout, /STILL FAILING/)
  assert.match(run.stdout, /fails an assertion/)
  assert.doesNotMatch(run.stdout, /⚠ FLAKY/)
  assert.equal(run.summary, "")
})

test("a rerun that recovers one assertion but stays failed is red, with no FLAKY anywhere", (t) => {
  const stub = stubPackage(t, retryRecoversOneAssertion)

  const run = runWrapper(stub, { CI: "true", GITHUB_STEP_SUMMARY: stub.summaryPath })

  assert.notEqual(run.status, 0)
  assert.equal(run.calls.length, 2)
  assert.match(run.stdout, /STILL FAILING/)
  assert.match(run.stdout, /always broken/)
  assert.doesNotMatch(run.stdout, /⚠ FLAKY/)
  assert.doesNotMatch(run.stdout, /::warning/)
  assert.equal(run.summary, "")
})

test("an unreadable report after a red run keeps the original exit code and says why", (t) => {
  const stub = stubPackage(t, () => [{ exit: 7, report: "not json at all" }])

  const run = runWrapper(stub, { CI: "true", GITHUB_STEP_SUMMARY: stub.summaryPath })

  assert.equal(run.status, 7)
  assert.equal(run.calls.length, 1)
  assert.match(run.stderr, /left no readable JSON report/)
  assert.equal(run.summary, "")
})

test("a red run with no failed test file keeps the original exit code and says why", (t) => {
  const stub = stubPackage(t, () => [
    {
      exit: 5,
      report: JSON.stringify({
        testResults: [{ name: "/x/src/a.test.ts", status: "passed", assertionResults: [] }],
      }),
    },
  ])

  const run = runWrapper(stub, { CI: "true", GITHUB_STEP_SUMMARY: stub.summaryPath })

  assert.equal(run.status, 5)
  assert.equal(run.calls.length, 1)
  assert.match(run.stderr, /marked no test file as failed/)
  assert.equal(run.summary, "")
})

test("without GITHUB_STEP_SUMMARY the flaky report still prints and nothing throws", (t) => {
  const stub = stubPackage(t, retryOnceThenPass)

  const run = runWrapper(stub, { CI: "true" })

  assert.equal(run.status, 0)
  assert.match(run.stdout, /⚠ FLAKY/)
  assert.doesNotMatch(run.stderr, /Error/)
  assert.equal(run.summary, "")
})

test("withLeasedWorkers adds the leased count, defers to an explicit one, and no-ops without a lease", () => {
  assert.deepEqual(withLeasedWorkers(["--testTimeout=30000"], 8), ["--testTimeout=30000", "--maxWorkers=8"])
  assert.deepEqual(withLeasedWorkers(["--maxWorkers=2"], 8), ["--maxWorkers=2"])
  assert.deepEqual(withLeasedWorkers(["--maxWorkers", "2"], 8), ["--maxWorkers", "2"])
  assert.deepEqual(withLeasedWorkers(["--testTimeout=30000"], null), ["--testTimeout=30000"])
})
