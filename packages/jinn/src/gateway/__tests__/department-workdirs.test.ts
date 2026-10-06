import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** FR-033: which directories a department may name as a working directory. */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-department-workdirs-")));
const home = path.join(root, "home");
const jinnHome = path.join(home, ".jinn");
const savedHome = process.env.HOME;
process.env.HOME = home;
process.env.JINN_HOME = jinnHome;

const git = (cwd: string) => execFileSync("git", ["init", "-q", cwd], { stdio: "ignore" });
const mkdir = (...parts: string[]) => fs.mkdirSync(path.join(home, ...parts), { recursive: true });

type Workdirs = typeof import("../department-workdirs.js");
let workdirs: Workdirs;

beforeAll(async () => {
  workdirs = await import("../department-workdirs.js");
  for (const dir of [".jinn", ".claude/projects", ".ssh", ".config/tool", ".aws", ".gnupg", "Library/Caches", "code/garden-app", "code/plain", ".jinn-departments/side-project"]) mkdir(dir);
  git(path.join(home, "code/garden-app"));
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const refusal = (dir: string) => workdirs.workdirRefusal(dir);

describe("a valid working directory", () => {
  it("is a directory inside a git work tree below the home directory", () => {
    mkdir("code/garden-app/src");
    expect(refusal(path.join(home, "code/garden-app"))).toBeNull();
    expect(refusal(path.join(home, "code/garden-app/src"))).toBeNull();
    expect(refusal("~/code/garden-app")).toBeNull();
  });

  it("is stored as its realpath", () => {
    fs.symlinkSync(path.join(home, "code/garden-app"), path.join(home, "code/link"));
    expect(refusal(path.join(home, "code/link"))).toBeNull();
    expect(workdirs.normalisedWorkdir(path.join(home, "code/link"))).toBe(path.join(home, "code/garden-app"));
  });
});

describe("a refused working directory", () => {
  it.each([
    ["the home directory", () => home],
    ["an ancestor of the home directory", () => root],
    ["the instance home", () => jinnHome],
    ["an ancestor of the instance home that is not the home", () => path.dirname(jinnHome)],
    ["the stage root", () => path.join(home, ".jinn-departments")],
    ["inside the stage root", () => path.join(home, ".jinn-departments/side-project")],
    ["the Claude config directory", () => path.join(home, ".claude")],
    ["inside the Claude config directory", () => path.join(home, ".claude/projects")],
    ["inside ~/.ssh", () => path.join(home, ".ssh")],
    ["inside ~/.config", () => path.join(home, ".config/tool")],
    ["inside ~/.aws", () => path.join(home, ".aws")],
    ["inside ~/.gnupg", () => path.join(home, ".gnupg")],
    ["inside ~/Library", () => path.join(home, "Library/Caches")],
  ])("%s", (_label, dir) => {
    expect(refusal(dir())).not.toBeNull();
  });

  it("refuses a symlink that leads into a protected tree", () => {
    fs.symlinkSync(path.join(home, ".ssh"), path.join(home, "code/sneaky"));
    expect(refusal(path.join(home, "code/sneaky"))).toMatch(/protected/);
  });

  it("refuses a directory that is not in a git work tree", () => {
    expect(refusal(path.join(home, "code/plain"))).toMatch(/not inside a git work tree/);
  });

  it("refuses a path that is relative or does not exist", () => {
    expect(refusal("code/garden-app")).toMatch(/not an absolute path/);
    expect(refusal(path.join(home, "code/missing"))).toMatch(/does not exist/);
  });

  it("refuses a work tree rooted at the home directory (a dotfiles home)", () => {
    git(home);
    try {
      expect(refusal(path.join(home, "code/plain"))).toMatch(/rooted at the home directory/);
      expect(refusal(path.join(home, "code/garden-app"))).toBeNull(); // its own repo still counts
    } finally {
      fs.rmSync(path.join(home, ".git"), { recursive: true, force: true });
    }
  });
});

describe("an employee's Claude profile directory", () => {
  it("is refused, and so is anything inside it, once a caller names the profiles", () => {
    mkdir(".claude-friend/projects");
    const options = { claudeConfigDirs: [path.join(home, ".claude-friend")] };
    expect(workdirs.workdirRefusal(path.join(home, ".claude-friend"), options)).not.toBeNull();
    expect(workdirs.workdirRefusal(path.join(home, ".claude-friend/projects"), options)).toMatch(/protected/);
    expect(workdirs.workdirRefusal(path.join(home, "code/garden-app"), options)).toBeNull();
  });
});

describe("the gateway's own Claude profile", () => {
  it("is refused, and so is what contains it, when CLAUDE_CONFIG_DIR puts it outside ~/.claude", () => {
    mkdir("code/garden-app/gateway-profile/projects");
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(home, "code/garden-app/gateway-profile");
    try {
      expect(refusal(path.join(home, "code/garden-app"))).toMatch(/is, or contains/);
      expect(refusal(path.join(home, "code/garden-app/gateway-profile"))).not.toBeNull();
      expect(refusal(path.join(home, "code/garden-app/gateway-profile/projects"))).toMatch(/protected/);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
    expect(refusal(path.join(home, "code/garden-app"))).toBeNull();
  });
});

describe("a path spelled in another case", () => {
  const caseInsensitive = root !== root.toUpperCase() && fs.existsSync(root.toUpperCase());

  it.skipIf(!caseInsensitive)("is judged by what is on disk, so a protected tree cannot be reached by changing its case", () => {
    const repo = path.join(home, ".config/tool/repo");
    fs.mkdirSync(repo, { recursive: true });
    git(repo);
    expect(refusal(path.join(home, ".CONFIG/tool/repo"))).toMatch(/protected/);
    expect(refusal(path.join(home, ".Claude"))).not.toBeNull();
    expect(refusal(path.join(home, "CODE/garden-app"))).toBeNull();
  });
});
