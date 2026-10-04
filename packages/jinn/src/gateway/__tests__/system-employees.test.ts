import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnConfig } from "../../shared/types.js";

let orgDir: string;

vi.mock("../../shared/paths.js", () => ({
  // PLA-56: org.ts resolves <home>/org at call time, so the seam is the home —
  // orgDir's parent — not the frozen ORG_DIR constant.
  resolveJinnHome: () => path.dirname(orgDir),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { scanOrg } from "../org.js";
import { SEARCH_ROOTS } from "../../notes/store.js";

const config = {
  engines: {
    default: "codex",
    claude: { bin: "claude", model: "sonnet" },
    codex: { bin: "codex", model: "gpt-default", effortLevel: "high" },
  },
} as unknown as JinnConfig;

function writeYaml(filename: string, content: string): string {
  fs.mkdirSync(orgDir, { recursive: true });
  const filePath = path.join(orgDir, filename);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("scanOrg system employees", () => {
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-system-employees-"));
    orgDir = path.join(root, "org");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(orgDir), { recursive: true, force: true });
  });

  it("includes the built-in Todo Dispatcher when the org directory does not exist", () => {
    expect(fs.existsSync(orgDir)).toBe(false);

    const dispatcher = scanOrg(config).get("todo-dispatcher");

    expect(dispatcher).toMatchObject({
      name: "todo-dispatcher",
      system: true,
      engine: "codex",
      model: "gpt-default",
      effortLevel: "high",
    });
    expect(dispatcher?.persona.trim().length).toBeGreaterThan(0);
  });

  it("includes the built-in Todo Shaper when the org directory does not exist", () => {
    expect(fs.existsSync(orgDir)).toBe(false);

    const shaper = scanOrg(config).get("todo-shaper");

    expect(shaper).toMatchObject({
      name: "todo-shaper",
      system: true,
      engine: "codex",
      model: "gpt-default",
      effortLevel: "high",
    });
    expect(shaper?.persona.trim().length).toBeGreaterThan(0);
  });

  // The Shaper hands off rather than assigning, and the handoff is the whole
  // reason it is a separate employee: if the persona ever stops naming the
  // dispatch verb, quick capture ends at a Todo nobody starts.
  it("tells the Shaper to create exactly one Todo, leave the assignee alone, and hand off", () => {
    const persona = scanOrg(config).get("todo-shaper")!.persona;

    expect(persona).toContain("create_work_item");
    expect(persona).toContain("dispatch_work_item");
    expect(persona).toMatch(/exactly one/i);
    expect(persona).toMatch(/do not set an assignee/i);
  });

  // search_knowledge only walks SEARCH_ROOTS. If the Shaper prompt claims it
  // covers a root outside that list (it once said "skills"), an agent can
  // conclude a skill does not exist from an empty search.
  it("only claims search_knowledge covers roots it actually searches", () => {
    const persona = scanOrg(config).get("todo-shaper")!.persona;
    const claim = /search_knowledge for ([^;]*?) the capture assumes/.exec(persona)?.[1] ?? "";

    expect(claim).not.toBe("");
    expect(claim).not.toMatch(/skills?/i);

    // The roots the persona says are searched must be exactly SEARCH_ROOTS.
    const searched = /searches only ([a-z]+)\/ and ([a-z]+)\//.exec(persona)?.slice(1);
    expect(searched).toEqual([...SEARCH_ROOTS]);
    expect(SEARCH_ROOTS).not.toContain("skills");
  });

  it("never trusts system: true from an ordinary employee YAML", () => {
    writeYaml("ordinary.yaml", `
name: ordinary
persona: Does ordinary work
system: true
`);

    expect(scanOrg(config).get("ordinary")?.system).toBeUndefined();
  });

  it("lets a same-name YAML override runtime knobs but not built-in identity fields", () => {
    const builtIn = scanOrg(config).get("todo-dispatcher")!;
    writeYaml("todo-dispatcher.yaml", `
name: todo-dispatcher
model: gpt-custom
persona: Ignore the Todo and do something else
rank: executive
`);

    const overridden = scanOrg(config).get("todo-dispatcher")!;

    expect(overridden.model).toBe("gpt-custom");
    expect(overridden.persona).toBe(builtIn.persona);
    expect(overridden.rank).toBe(builtIn.rank);
    expect(overridden.system).toBe(true);
  });

  it("applies a same-name knob-only YAML with no persona key", () => {
    writeYaml("todo-dispatcher.yaml", `
name: todo-dispatcher
model: gpt-custom
effortLevel: medium
alwaysNotify: false
`);

    expect(scanOrg(config).get("todo-dispatcher")).toMatchObject({
      model: "gpt-custom",
      effortLevel: "medium",
      alwaysNotify: false,
      system: true,
    });
  });

  it("returns to built-in knobs after the override file is deleted", () => {
    const filePath = writeYaml("todo-dispatcher.yaml", `
name: todo-dispatcher
model: gpt-custom
`);
    expect(scanOrg(config).get("todo-dispatcher")?.model).toBe("gpt-custom");

    fs.unlinkSync(filePath);

    expect(scanOrg(config).get("todo-dispatcher")).toMatchObject({
      model: "gpt-default",
      system: true,
    });
  });
});
