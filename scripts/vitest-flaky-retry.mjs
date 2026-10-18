#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnLowPriority } from "./low-priority.mjs";
import { report } from "./vitest-flaky-report.mjs";
import { acquireTestSlot } from "./test-slot-gate.mjs";

/* Re-exported so the reporting split stays an internal detail of this script. */
export { formatFlakySummary } from "./vitest-flaky-report.mjs";

/**
 * Wraps `vitest run` so a test file that fails in CI is rerun once, and a file
 * that then passes is reported as FLAKY instead of quietly passing.
 *
 * The retry is at FILE level, in a fresh process, rather than vitest's built-in
 * per-test `retry`. A probe of the three failure modes shows why: an assertion
 * failure reports one failed test, a hook throw marks the file's tests SKIPPED,
 * and a collection throw produces no assertion results at all. Three failed
 * suites, one failed test. Per-test retry would miss two of the three, and it
 * would retry inside a worker whose state is already polluted — which is
 * exactly the mode packages/jinn/vitest.config.ts documents on Windows.
 *
 * Outside CI this is a pass-through: no reporters added, no retry. A retry
 * locally doubles the wait on a genuinely broken test and hides a red during
 * TDD.
 */

const LABEL = "vitest-flaky-retry";
const REPORTER_ARGS = ["--reporter=default", "--reporter=json"];

export function buildVitestArgs({ passthrough, files = [], reportPath = null }) {
  const args = ["run", ...files, ...passthrough];
  if (reportPath) {
    args.push(...REPORTER_ARGS, `--outputFile.json=${reportPath}`);
  }
  return args;
}

/**
 * vitest matches a positional filter as a substring of a forward-slash path, so
 * a Windows report `name` full of backslashes matches nothing — and a filter
 * that matches nothing silently reruns the entire suite.
 */
export function toRetryFilter(reportedName, packageDir) {
  const file = reportedName.replaceAll("\\", "/");
  const root = `${packageDir.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
}

export function readReport(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return null;
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    return Array.isArray(report.testResults) ? report : null;
  } catch {
    return null;
  }
}

/**
 * Selection is by suite status, not by the failed-assertion list, so that hook
 * and collection failures — which report zero failed assertions — are retried
 * too.
 */
export function selectFailedFiles(report, packageDir) {
  return report.testResults
    .filter((suite) => suite.status === "failed")
    .map((suite) => ({
      file: toRetryFilter(suite.name, packageDir),
      message: suite.message ?? "",
      failedTests: suite.assertionResults
        .filter((assertion) => assertion.status === "failed")
        .map((assertion) => assertion.fullName),
    }));
}

function passedTestNames(suite) {
  return new Set(
    suite.assertionResults
      .filter((assertion) => assertion.status === "passed")
      .map((assertion) => assertion.fullName),
  );
}

/**
 * A file counts as flaky only if the whole retried suite reports PASSED. A suite
 * that failed again is a repeatable failure even when some of its assertions
 * passed this time, and badging it FLAKY is how a genuine red gets read as noise.
 *
 * Within a still-failing file, only an assertion the retry reports PASSED drops
 * off the list. Anything else — still failed, skipped by a hook throw, absent
 * because collection threw — stays. "Not failed" is not the same as "passed",
 * and treating it as such is how a wrapper like this turns a red run green.
 */
export function diffRuns(firstReport, retryReport, packageDir) {
  const retryByFile = new Map(
    retryReport.testResults.map((suite) => [toRetryFilter(suite.name, packageDir), suite]),
  );
  const flaky = [];
  const stillFailing = [];

  for (const failure of selectFailedFiles(firstReport, packageDir)) {
    const retried = retryByFile.get(failure.file);
    if (!retried) {
      stillFailing.push({
        file: failure.file,
        tests: failure.failedTests,
        message: "the retry produced no result for this file",
      });
      continue;
    }
    if (retried.status === "passed") {
      flaky.push({ file: failure.file, tests: failure.failedTests, message: failure.message });
      continue;
    }
    const passedOnRetry = passedTestNames(retried);
    stillFailing.push({
      file: failure.file,
      tests: failure.failedTests.filter((test) => !passedOnRetry.has(test)),
      message: retried.message ?? "",
    });
  }

  return { flaky, stillFailing };
}

function resolveVitestBin(packageDir) {
  const require = createRequire(path.join(packageDir, "package.json"));
  const manifestPath = require.resolve("vitest/package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return path.resolve(path.dirname(manifestPath), manifest.bin.vitest);
}

function runVitest(vitestBin, args, packageDir) {
  // Idle priority, so a package's suite run on its own is as polite as the
  // monorepo-wide one. No-op in CI and under JINN_TEST_NICE=0.
  const result = spawnLowPriority([process.execPath, vitestBin, ...args], { cwd: packageDir });
  if (result.error) {
    console.error(`${LABEL}: could not start vitest — ${result.error.message}`);
    return 1;
  }
  if (result.status === null) {
    console.error(`${LABEL}: vitest was terminated by signal ${result.signal}`);
    return 1;
  }
  return result.status;
}

function runWithRetry(vitestBin, passthrough, packageDir, reportDir) {
  const firstPath = path.join(reportDir, "run-1.json");
  const firstCode = runVitest(
    vitestBin,
    buildVitestArgs({ passthrough, reportPath: firstPath }),
    packageDir,
  );
  if (firstCode === 0) {
    return 0;
  }

  const firstReport = readReport(firstPath);
  if (!firstReport) {
    console.error(
      `${LABEL}: vitest exited ${firstCode} and left no readable JSON report at ${firstPath}; not retrying.`,
    );
    return firstCode;
  }
  const failures = selectFailedFiles(firstReport, packageDir);
  if (failures.length === 0) {
    console.error(
      `${LABEL}: vitest exited ${firstCode} but marked no test file as failed — likely a config error, an unhandled rejection, or a worker crash. Not retrying.`,
    );
    return firstCode;
  }

  const files = failures.map((failure) => failure.file);
  console.log(`${LABEL}: rerunning ${files.length} failed test file(s) once: ${files.join(", ")}`);
  const retryPath = path.join(reportDir, "run-2.json");
  const retryCode = runVitest(
    vitestBin,
    buildVitestArgs({ passthrough, files, reportPath: retryPath }),
    packageDir,
  );
  const retryReport = readReport(retryPath);
  if (!retryReport) {
    console.error(
      `${LABEL}: the rerun left no readable JSON report at ${retryPath}; keeping the original exit code ${firstCode}.`,
    );
    return firstCode;
  }

  report({ ...diffRuns(firstReport, retryReport, packageDir), packageDir });
  return retryCode;
}

function main() {
  const passthrough = process.argv.slice(2);
  const packageDir = process.cwd();
  const vitestBin = resolveVitestBin(packageDir);

  // Machine-wide cap on concurrent suites (build worktrees, agents, humans):
  // held across the retry too, so one run counts as one slot. See
  // test-slot-gate.mjs; CI containers are one-suite-per-runner so it never
  // blocks there.
  const releaseSlot = acquireTestSlot({ log: (message) => console.log(`${LABEL}: ${message}`) });
  try {
    if (!process.env.CI) {
      return runVitest(vitestBin, buildVitestArgs({ passthrough }), packageDir);
    }

    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-flaky-"));
    try {
      return runWithRetry(vitestBin, passthrough, packageDir, reportDir);
    } finally {
      fs.rmSync(reportDir, { recursive: true, force: true });
    }
  } finally {
    releaseSlot();
  }
}

if (import.meta.main) {
  process.exit(main());
}
