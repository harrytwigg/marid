import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAntigravityPrintModeError } from "../antigravity-cli-log.js";

/** Verbatim from ~/.gemini/antigravity-cli/log after a real `agy --print-timeout 10s` run. */
const TIMEOUT_LINE = "ERROR: logging before google.Init: E0824 01:30:11.830534       1"
  + " printmode.go:521] Print mode: timed out after 50 polls (printed=2)";
const INFO_LINE = "ERROR: logging before google.Init: I0824 01:29:58.842611       1"
  + " printmode.go:173] Print mode: starting (promptLength=0, model=\"\", conversationID=\"\")";

let logDir: string;

function writeLog(name: string, body: string, mtimeMs: number): string {
  const filePath = path.join(logDir, name);
  fs.writeFileSync(filePath, body);
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

beforeEach(() => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-cli-log-test-"));
});

afterEach(() => {
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe("readAntigravityPrintModeError", () => {
  it("quotes agy's print-mode timeout from a log written during the turn", () => {
    const turnStartedAtMs = Date.now();
    writeLog("cli-now.log", `${INFO_LINE}\n${TIMEOUT_LINE}\n`, turnStartedAtMs + 1000);

    expect(readAntigravityPrintModeError(turnStartedAtMs, logDir))
      .toBe("Print mode: timed out after 50 polls (printed=2)");
  });

  it("ignores a log that was last written before the turn started", () => {
    const turnStartedAtMs = Date.now();
    writeLog("cli-stale.log", `${TIMEOUT_LINE}\n`, turnStartedAtMs - 60_000);

    expect(readAntigravityPrintModeError(turnStartedAtMs, logDir)).toBeUndefined();
  });

  it("ignores informational print-mode lines", () => {
    const turnStartedAtMs = Date.now();
    writeLog("cli-info.log", `${INFO_LINE}\n`, turnStartedAtMs + 1000);

    expect(readAntigravityPrintModeError(turnStartedAtMs, logDir)).toBeUndefined();
  });

  it("reports the last error when a log carries several", () => {
    const turnStartedAtMs = Date.now();
    const earlier = TIMEOUT_LINE.replace("printmode.go:521] Print mode: timed out after 50 polls (printed=2)",
      "printmode.go:400] Print mode: transient stream error");
    writeLog("cli-multi.log", `${earlier}\n${TIMEOUT_LINE}\n`, turnStartedAtMs + 1000);

    expect(readAntigravityPrintModeError(turnStartedAtMs, logDir))
      .toBe("Print mode: timed out after 50 polls (printed=2)");
  });

  it("reads only the tail of a log that has grown past the cap", () => {
    const turnStartedAtMs = Date.now();
    const padding = "x".repeat(64 * 1024);
    writeLog("cli-huge.log", `${TIMEOUT_LINE}\n${padding}\n`, turnStartedAtMs + 1000);

    expect(readAntigravityPrintModeError(turnStartedAtMs, logDir)).toBeUndefined();
  });

  it("returns nothing when the log directory does not exist", () => {
    expect(readAntigravityPrintModeError(Date.now(), path.join(logDir, "absent")))
      .toBeUndefined();
  });

  it("skips directories that sort ahead of the newest log", () => {
    const turnStartedAtMs = Date.now();
    fs.mkdirSync(path.join(logDir, "rotated"));
    writeLog("cli-now.log", `${TIMEOUT_LINE}\n`, turnStartedAtMs + 1000);

    expect(readAntigravityPrintModeError(turnStartedAtMs, logDir))
      .toBe("Print mode: timed out after 50 polls (printed=2)");
  });
});
