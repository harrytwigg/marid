import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `jinn remote status` for a department-scoped employee shows where it really runs, the
 * department's stage directory, and names the department and the employee's own work
 * area (FR-061). An unscoped employee's line is as it was.
 */

const hoisted = vi.hoisted(() => ({ targets: [] as any[], logs: [] as string[] }));

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ engines: { default: "claude" }, remote: { root: "/srv/root", mount: "/mnt/jinn" } })),
}));

vi.mock("../../gateway/org.js", () => ({
  scanOrg: vi.fn(() => new Map([
    ["side-dev", { name: "side-dev", displayName: "Side Dev", department: "side-project", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work" }],
    ["eng-dev", { name: "eng-dev", displayName: "Eng Dev", department: "engineering", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/eng" }],
  ])),
}));

vi.mock("../../gateway/department-registry.js", () => ({
  departmentScopeOf: (slug: string) => (slug === "side-project" ? "scoped" : "open"),
}));

vi.mock("../../engines/remote-stage.js", () => ({
  ensureRemoteReady: vi.fn(async (target: any) => {
    hoisted.targets.push(target);
    return { ready: true, facts: { jinnVersion: "0.32.0", nodeBin: "/usr/bin/node", stageDir: "/home/ci/.jinn-remote-stage", claudeBin: "/usr/bin/claude" } };
  }),
  sendWakeOnLan: vi.fn(async () => {}),
  clearRemoteFactsCache: vi.fn(),
  remoteEngineBin: vi.fn(),
}));

import { remoteStatus } from "../remote.js";

const output = () => hoisted.logs.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

beforeEach(() => {
  hoisted.targets.length = 0;
  hoisted.logs.length = 0;
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => { hoisted.logs.push(String(line ?? "")); });
});

describe("jinn remote status", () => {
  it("shows a scoped employee's stage directory, and a line naming its department and work area", async () => {
    await remoteStatus("side-dev");
    expect(hoisted.targets[0]).toMatchObject({ remoteCwd: "/srv/root/.jinn-departments/side-project", remoteDepartment: "side-project", remoteWorkArea: "/srv/root/work" });
    expect(output()).toContain("✓ side-dev ci@build-box:/srv/root/.jinn-departments/side-project");
    expect(output()).toMatch(/department side-project: .*stage directory; work area \/srv\/root\/work/);
  });

  it("shows an unscoped employee's own directory and no department line", async () => {
    await remoteStatus("eng-dev");
    expect(output()).toContain("✓ eng-dev ci@build-box:/srv/root/eng");
    expect(output()).not.toContain("department ");
  });
});
