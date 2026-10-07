import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FR-061: a remote target is built from an employee only by `employeeRemoteTarget`
 * (shared/remote-target.ts), which puts a scoped employee's session in its department's
 * stage directory. A site that reads `employee.remoteCwd` itself to build a target would
 * run a scoped session in its work area instead, with the company home a link away.
 * This fails on any such read outside the allow-list below.
 *
 * It matches reads off a value named `employee` (any suffix, `?.` or `!.` included) and
 * destructuring of `remoteCwd` from one, which is how every site names an employee
 * record; a struct of another name with its own `remoteCwd` field does not trip it.
 */

const SRC = path.resolve(__dirname, "..", "..");

/** Where a read is allowed, and how many, with the reason. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "shared/remote-target.ts": { count: 1, why: "employeeRemoteTarget itself" },
  "gateway/org-department-check.ts": { count: 1, why: "validates a scoped employee's work area when the roster loads; builds no target" },
  "sessions/context/department-scope.ts": { count: 2, why: "names the work area in a scoped session's prompt; builds no target" },
  "board-walk/route-turn.ts": { count: 1, why: "strips the remote fields so the walk turn runs locally; builds no target" },
  "cli/remote.ts": { count: 1, why: "a RemoteEmployee display row named `employee`, whose remoteCwd came from employeeRemoteTarget" },
};

const READS = [
  /\bemployee\w*[?!]?\.remoteCwd\b/g,
  /\{[^}]*\bremoteCwd\b[^}]*\}\s*=\s*[\w.?!]*employee\w*\b/g,
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function count(text: string): number {
  return READS.reduce((sum, pattern) => sum + (text.match(pattern) ?? []).length, 0);
}

describe("reads of an employee's remoteCwd", () => {
  const found = new Map<string, number>();
  for (const file of sources(SRC)) {
    const n = count(fs.readFileSync(file, "utf-8"));
    if (n > 0) found.set(path.relative(SRC, file).split(path.sep).join("/"), n);
  }

  it("appear only where the allow-list says", () => {
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([file, { count: n }]) => [file, n])));
  });

  it("catches the shapes a target used to be built with", () => {
    expect(count("remoteCwd: input.employee?.remoteCwd,")).toBe(1);
    expect(count("remoteCwd: employee?.remoteCwd ?? remoteCwd,")).toBe(1);
    expect(count("const { remoteHost, remoteCwd } = input.employee!;")).toBe(1);
    expect(count("remoteCwd: entry.remoteCwd ?? \"\",")).toBe(0);
  });

  it.each([
    "sessions/turn/engine-run.ts",
    "sessions/turn/rate-limit-turn.ts",
    "sessions/rate-limit-remote-target.ts",
    "sessions/turn/remote-ready.ts",
    "gateway/pty-ws.ts",
    "gateway/session-file-read.ts",
    "cli/remote.ts",
  ])("%s builds its target through employeeRemoteTarget with a scope", (file) => {
    const text = fs.readFileSync(path.join(SRC, file), "utf-8");
    expect(text).toMatch(/employeeRemoteTarget\([^)]*,\s*(?:remoteScopeFor\(|scope\b)/);
  });
});
