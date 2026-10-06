import { call, context, startScopedHarness } from "./department-scope-harness.js";
import fs from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { logger } from "../../shared/logger.js";
import { orgRegistry, refreshOrg } from "../org-registry.js";
import { writeEmployeeFile } from "./department-fixtures.js";
import type { RemoteExecutionConfig } from "../../shared/config-types.js";

/**
 * FR-061 at load, and where a scope change meets it: a scoped employee's remote work area
 * must stay clear of `<remote.root>/.jinn-departments` and of `remote.mount`, and the mount
 * must stay clear of the departments root. An unscoped employee is not held to it.
 */

const CLEAN: RemoteExecutionConfig = { root: "/srv/root", mount: "/mnt/jinn" } as RemoteExecutionConfig;
let remote: RemoteExecutionConfig = CLEAN;
const planted: string[] = [];

beforeAll(async () => {
  await startScopedHarness();
  const base = context.getConfig;
  (context as { getConfig: typeof base }).getConfig = () => ({ ...base(), remote });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const file of planted.splice(0)) fs.rmSync(file, { force: true });
  remote = CLEAN;
  refreshOrg(context.getConfig());
});

function plant(directory: string, name: string, remoteCwd: string): string[] {
  planted.push(writeEmployeeFile(directory, name, { remoteHost: "build-box", remoteUser: "ci", remoteCwd }));
  const logged: string[] = [];
  vi.spyOn(logger, "error").mockImplementation((message: unknown) => { logged.push(String(message)); });
  refreshOrg(context.getConfig());
  return logged;
}
const loaded = (name: string) => orgRegistry(context.getConfig()).has(name);

describe("the org scan, with a remote block", () => {
  it("loads a scoped employee whose work area is clear", () => {
    const logged = plant("side-project", "scan-clean", "/srv/root/work");
    expect(loaded("scan-clean")).toBe(true);
    expect(logged).toEqual([]);
  });

  it.each([
    ["equals", "/srv/root/.jinn-departments"],
    ["contains", "/srv/root"],
    ["lies inside", "/srv/root/.jinn-departments/side-project"],
  ])("drops a scoped employee whose work area %s the departments root, and says why", (_how, area) => {
    const logged = plant("side-project", "scan-departments", area);
    expect(loaded("scan-departments")).toBe(false);
    expect(logged.join("\n")).toMatch(/scan-departments\.yaml: .*non-open department "side-project".*overlaps "\/srv\/root\/\.jinn-departments"/);
  });

  it.each([
    ["equals", "/srv/root/mnt"],
    ["lies inside", "/srv/root/mnt/knowledge"],
  ])("drops a scoped employee whose work area %s the mount, and says why", (_how, area) => {
    remote = { root: "/srv/root", mount: "/srv/root/mnt" } as RemoteExecutionConfig;
    const logged = plant("side-project", "scan-mount", area);
    expect(loaded("scan-mount")).toBe(false);
    expect(logged.join("\n")).toMatch(/scan-mount\.yaml: .*overlaps remote\.mount "\/srv\/root\/mnt"/);
  });

  it("drops a scoped employee whose work area contains the mount", () => {
    remote = { root: "/srv/root", mount: "/srv/root/work/mnt" } as RemoteExecutionConfig;
    const logged = plant("side-project", "scan-contains-mount", "/srv/root/work");
    expect(loaded("scan-contains-mount")).toBe(false);
    expect(logged.join("\n")).toMatch(/overlaps remote\.mount/);
  });

  it("drops a scoped remote employee when the mount sits under the departments root, even with a clean work area", () => {
    remote = { root: "/srv/root", mount: "/srv/root/.jinn-departments/mnt" } as RemoteExecutionConfig;
    const logged = plant("side-project", "scan-mount-under", "/srv/root/work");
    expect(loaded("scan-mount-under")).toBe(false);
    expect(logged.join("\n")).toMatch(/scan-mount-under\.yaml: .*remote\.mount .* overlaps "\/srv\/root\/\.jinn-departments"/);
  });

  it("drops an unscoped remote employee whose remoteCwd is in the departments root too: its farm would link the company CLAUDE.md there", () => {
    const logged = plant("engineering", "scan-unscoped", "/srv/root/.jinn-departments/anything");
    expect(loaded("scan-unscoped")).toBe(false);
    expect(logged.join("\n")).toMatch(/scan-unscoped\.yaml: remoteCwd "\/srv\/root\/\.jinn-departments\/anything" lies in "\/srv\/root\/\.jinn-departments"/);
  });

  it("still loads an unscoped remote employee whose work area is over the mount, as before", () => {
    plant("engineering", "scan-unscoped-mount", "/srv/root/mnt/sub");
    expect(loaded("scan-unscoped-mount")).toBe(true);
  });
});

describe("a change into a scoped department", () => {
  const OVER_MOUNT = "/srv/root/mnt/sub";

  it("is refused through PATCH /api/departments/:slug, naming the remote employee and the reason", async () => {
    remote = { root: "/srv/root", mount: "/srv/root/mnt" } as RemoteExecutionConfig;
    plant("build-dept", "scope-remote-dev", OVER_MOUNT);
    expect(loaded("scope-remote-dev")).toBe(true);
    const refused = await call("PATCH", "/api/departments/build-dept", { scope: "scoped" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("department-members");
    expect(refused.body.error).toContain("scope-remote-dev");
    expect(refused.body.error).toContain('overlaps remote.mount "/srv/root/mnt"');
    expect(loaded("scope-remote-dev")).toBe(true);
  });

  // The move rule (FR-007) answers first for any move into a scoped department, so this does
  // not isolate the remote check; it pins that the move is refused and the employee stays put.
  it("is refused through PATCH /api/org/employees/:name for a remote employee with such a work area", async () => {
    remote = { root: "/srv/root", mount: "/srv/root/mnt" } as RemoteExecutionConfig;
    plant("engineering", "move-remote-dev", OVER_MOUNT);
    const refused = await call("PATCH", "/api/org/employees/move-remote-dev", { department: "side-project" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("move-remote-dev");
    expect(orgRegistry(context.getConfig()).get("move-remote-dev")?.department).toBe("engineering");
  });
});
