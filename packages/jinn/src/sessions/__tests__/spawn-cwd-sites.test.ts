import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FR-020b: every local spawn of a session takes its cwd from `spawnCwd`
 * (sessions/session-cwd.ts), so a scoped session never starts, retries or attaches in
 * the Jinn home. This fails on any hard-coded `cwd: JINN_HOME` outside the allow-list
 * below, so a new spawn site cannot bring the old behaviour back unnoticed.
 */

const SRC = path.resolve(__dirname, "..", "..");

/** Where a literal `cwd: JINN_HOME` is allowed, and how many times, with the reason. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "engines/claude-interactive.ts": { count: 2, why: "the ssh client's own local cwd; the session's cwd is the `cd` in the remote command" },
  "engines/opencode-interactive.ts": { count: 1, why: "opencode: a scoped employee cannot use it (FR-026)" },
  "engines/opencode-launch.ts": { count: 1, why: "opencode: a scoped employee cannot use it (FR-026)" },
  "engines/opencode-server.ts": { count: 2, why: "opencode: a scoped employee cannot use it (FR-026)" },
  "engines/pi.ts": { count: 1, why: "pi: a scoped employee cannot use it (FR-026)" },
};

const HARD_CODED_CWD = /\bcwd:\s*(?:JINN_HOME|resolveJinnHome\(\)|process\.env\.JINN_HOME)\b/g;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("hard-coded `cwd: JINN_HOME` at session-spawn sites", () => {
  const found = new Map<string, number>();
  for (const file of sources(SRC)) {
    const count = (fs.readFileSync(file, "utf-8").match(HARD_CODED_CWD) ?? []).length;
    if (count > 0) found.set(path.relative(SRC, file).split(path.sep).join("/"), count);
  }

  it("appears only where the allow-list says", () => {
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([file, { count }]) => [file, count])));
  });

  it.each([
    "sessions/turn/engine-run.ts",
    "sessions/rate-limit-handler.ts",
    "gateway/pty-ws.ts",
  ])("%s takes its cwd from the helper", (file) => {
    const text = fs.readFileSync(path.join(SRC, file), "utf-8");
    expect(text).toMatch(/spawnCwd\(/);
    expect(text).not.toMatch(HARD_CODED_CWD);
  });

  it("calls the helper at both rate-limit spawn sites", () => {
    const text = fs.readFileSync(path.join(SRC, "sessions/rate-limit-handler.ts"), "utf-8");
    expect((text.match(/\bspawnCwd\(/g) ?? []).length).toBe(2);
    expect(text).toMatch(/cwd: substituteCwd,/);
    expect(text).toMatch(/cwd: spawnCwd\(session\),/);
  });
});
