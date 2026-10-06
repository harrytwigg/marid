import { describe, expect, it } from "vitest";
import type { RemoteExecutionConfig } from "../config-types.js";
import {
  ancestorMemoryExcludes,
  assertScopedRemoteSpawn, remotePathsOverlap, remoteDepartmentStageDir, scopedRemoteTargetProblem,
  type RemoteScope,
} from "../remote-department.js";
import { employeeRemoteTarget, validateRemoteTarget } from "../remote-target.js";
import type { Employee, SessionRemoteTarget } from "../types.js";
import { remoteDepartmentEnv, remoteDepartmentFileRoots, scopedRemoteDepartment } from "../../engines/remote-department-stage.js";

/** Where a department-scoped employee runs on a remote host (FR-060, FR-061, FR-064, FR-065). */

const remote = { root: "/srv/root", mount: "/mnt/jinn" } as RemoteExecutionConfig;
const STAGE = "/srv/root/.jinn-departments/side-project";

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    name: "side-dev", displayName: "Side Dev", department: "side-project", rank: "employee", engine: "claude",
    model: "opus", persona: "p", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work",
    remoteClaudeConfigDir: "/srv/profiles/a", ...overrides,
  } as Employee;
}

const scoped: RemoteScope = { departmentOf: () => "side-project", remoteRoot: "/srv/root" };

describe("employeeRemoteTarget for a scoped employee", () => {
  it("runs in the department's stage directory, keeps the work area, and passes host, user and profile through", () => {
    expect(employeeRemoteTarget(employee(), scoped)).toEqual({
      remoteHost: "build-box", remoteUser: "ci", remoteCwd: STAGE, remoteClaudeConfigDir: "/srv/profiles/a",
      remoteDepartment: "side-project", remoteWorkArea: "/srv/root/work",
    });
  });

  it("has no remoteCwd at all without remote.root, rather than falling back to the work area", () => {
    const target = employeeRemoteTarget(employee(), { ...scoped, remoteRoot: undefined })!;
    expect("remoteCwd" in target).toBe(false);
    expect(target).toMatchObject({ remoteDepartment: "side-project", remoteWorkArea: "/srv/root/work" });
  });

  it("leaves an unscoped employee's target without the department keys", () => {
    const target = employeeRemoteTarget(employee(), { ...scoped, departmentOf: () => null })!;
    expect(target).toEqual({ remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/srv/root/work", remoteClaudeConfigDir: "/srv/profiles/a" });
    expect("remoteDepartment" in target).toBe(false);
    expect("remoteWorkArea" in target).toBe(false);
  });
});

describe("remoteDepartmentStageDir", () => {
  it("refuses an empty, hidden or path-shaped department name", () => {
    for (const slug of ["", ".x", "a/b"]) expect(() => remoteDepartmentStageDir("/srv/root", slug), JSON.stringify(slug)).toThrow(/not a department name/);
    expect(remoteDepartmentStageDir("/srv/root", "side-project")).toBe(STAGE);
  });
});

describe("scopedRemoteTargetProblem", () => {
  it("accepts a clean work area, and none at all", () => {
    expect(scopedRemoteTargetProblem("/srv/root/work", remote)).toBeNull();
    expect(scopedRemoteTargetProblem(undefined, remote)).toBeNull();
  });

  it("refuses a work area that equals, contains or lies inside the departments root", () => {
    for (const area of ["/srv/root/.jinn-departments", "/srv/root", "/srv/root/.jinn-departments/side-project"]) {
      expect(scopedRemoteTargetProblem(area, remote), area).toMatch(/overlaps "\/srv\/root\/\.jinn-departments"/);
    }
  });

  it("refuses a work area that equals, contains or lies inside the mount", () => {
    for (const area of ["/mnt/jinn", "/mnt", "/mnt/jinn/knowledge"]) {
      expect(scopedRemoteTargetProblem(area, remote), area).toMatch(/overlaps remote\.mount "\/mnt\/jinn"/);
    }
  });

  it("refuses a mount that overlaps the departments root, with or without a work area", () => {
    for (const mount of ["/srv/root/.jinn-departments/mnt", "/srv/root", "/srv/root/.jinn-departments"]) {
      const config = { ...remote, mount } as RemoteExecutionConfig;
      expect(scopedRemoteTargetProblem(undefined, config), mount).toMatch(/remote\.mount .* overlaps/);
      expect(scopedRemoteTargetProblem("/srv/other/work", config), mount).toMatch(/remote\.mount .* overlaps/);
    }
  });

  it("compares paths with trailing slashes and the filesystem root", () => {
    expect(remotePathsOverlap("/a/b/", "/a/b")).toBe(true);
    expect(remotePathsOverlap("/a/", "/a/b/c/")).toBe(true);
    expect(remotePathsOverlap("/", "/anything/at/all")).toBe(true);
    expect(remotePathsOverlap("/a/bc", "/a/b")).toBe(false);
  });
});

describe("assertScopedRemoteSpawn", () => {
  const paths = { stageDir: STAGE, workArea: "/srv/root/work" };
  const hostRoot = "/home/u/.jinn-remote-stage";

  it("passes when the host's stage root is clear of both paths", () => {
    expect(() => assertScopedRemoteSpawn(paths, hostRoot, remote)).not.toThrow();
    expect(() => assertScopedRemoteSpawn({ stageDir: STAGE, workArea: undefined }, hostRoot, remote)).not.toThrow();
  });

  it("fails closed when the host's stage root is not known", () => {
    for (const unknown of [undefined, ""]) expect(() => assertScopedRemoteSpawn(paths, unknown, remote)).toThrow(/stage root is not known/);
  });

  it("refuses a stage directory that equals, contains or lies inside the host's stage root", () => {
    for (const root of [STAGE, `${STAGE}/inner`, "/srv/root", "/"]) {
      expect(() => assertScopedRemoteSpawn({ stageDir: STAGE, workArea: undefined }, root, remote), root).toThrow(/its stage directory .* overlaps the host's stage root/);
    }
  });

  it("refuses a work area that equals, contains or lies inside the host's stage root", () => {
    const area = "/home/u/work";
    for (const root of [area, `${area}/inner`, "/home/u", "/home"]) {
      expect(() => assertScopedRemoteSpawn({ stageDir: STAGE, workArea: area }, root, remote), root).toThrow(/its remoteCwd .* overlaps the host's stage root/);
    }
  });
});

describe("scopedRemoteDepartment and the helpers around it", () => {
  const facts = { stageDir: "/home/u/.jinn-remote-stage" };
  const target: SessionRemoteTarget = { remoteHost: "build-box", remoteCwd: STAGE, remoteDepartment: "side-project", remoteWorkArea: "/srv/root/work" };

  it("returns the department for a well-formed scoped target and nothing for an unscoped one", () => {
    expect(scopedRemoteDepartment(target, remote, facts, "claude")).toBe("side-project");
    expect(scopedRemoteDepartment({ remoteHost: "build-box", remoteCwd: "/srv/root/work" }, remote, facts, "pi")).toBeUndefined();
  });

  it("refuses a scoped target on an engine other than Claude", () => {
    expect(() => scopedRemoteDepartment(target, remote, facts, "pi")).toThrow(/department-scoped remote session on pi/);
  });

  it("refuses a scoped target whose remoteCwd is not the stage directory", () => {
    expect(() => scopedRemoteDepartment({ ...target, remoteCwd: "/srv/root/work" }, remote, facts, "claude")).toThrow(/runs in its department's stage directory/);
    expect(() => scopedRemoteDepartment({ ...target, remoteCwd: undefined }, remote, facts, "claude")).toThrow(/stage directory/);
  });

  it("sets JINN_DEPARTMENT only for a scoped session", () => {
    expect(remoteDepartmentEnv(undefined)).toEqual({});
    expect(remoteDepartmentEnv("d")).toEqual({ JINN_DEPARTMENT: "d" });
  });

  it("names the work area and the stage directory as a scoped session's file roots, and none otherwise", () => {
    expect(remoteDepartmentFileRoots(target)).toEqual(["/srv/root/work", STAGE]);
    expect(remoteDepartmentFileRoots({ remoteHost: "build-box", remoteCwd: "/srv/root/work" })).toEqual([]);
  });
});

describe("ancestorMemoryExcludes", () => {
  it("names every instruction file above the stage directory, under each spelling, and nothing inside it", () => {
    const excludes = ancestorMemoryExcludes(["/srv/root/.jinn-departments/side-project", "/data/root/.jinn-departments/side-project"]);
    for (const dir of ["/srv/root/.jinn-departments", "/srv/root", "/srv", "/data/root", "/data"]) {
      expect(excludes).toEqual(expect.arrayContaining([`${dir}/CLAUDE.md`, `${dir}/CLAUDE.local.md`, `${dir}/.claude/CLAUDE.md`, `${dir}/.claude/rules/**`]));
    }
    expect(excludes).toEqual(expect.arrayContaining(["/CLAUDE.md", "/CLAUDE.local.md"]));
    expect(excludes.some((pattern) => pattern.startsWith("/srv/root/.jinn-departments/side-project/"))).toBe(false);
    expect(new Set(excludes).size).toBe(excludes.length);
  });

  it("escapes glob characters in a path, so it matches only itself", () => {
    expect(ancestorMemoryExcludes(["/srv/my*root (1)/.jinn-departments/d"])).toContain("/srv/my\\*root \\(1\\)/CLAUDE.md");
  });
});

describe("validateRemoteTarget and the department stage directories", () => {
  const config = { root: "/srv/root", mount: "/mnt/jinn" } as RemoteExecutionConfig;
  const target = (remoteCwd: string, remoteDepartment?: string) => ({ remoteHost: "build-box", remoteCwd, ...(remoteDepartment ? { remoteDepartment } : {}) });

  it("refuses any employee whose remoteCwd is, or lies inside, the departments root", () => {
    for (const cwd of ["/srv/root/.jinn-departments", "/srv/root/.jinn-departments/", "/srv/root/.jinn-departments/side-project", "/srv/root/.jinn-departments/side-project/x"]) {
      expect(validateRemoteTarget(target(cwd), config)?.error, cwd).toMatch(/lies in "\/srv\/root\/\.jinn-departments"/);
    }
  });

  it("allows remote.root itself, which contains the departments root", () => {
    expect(validateRemoteTarget(target("/srv/root"), config)).toBeUndefined();
  });

  it("allows a scoped session's own stage directory, and no other department's", () => {
    expect(validateRemoteTarget(target("/srv/root/.jinn-departments/side-project", "side-project"), config)).toBeUndefined();
    expect(validateRemoteTarget(target("/srv/root/.jinn-departments/side-project/", "side-project"), config)).toBeUndefined();
    expect(validateRemoteTarget(target("/srv/root/.jinn-departments/other", "side-project"), config)?.error).toMatch(/lies in/);
  });
});
