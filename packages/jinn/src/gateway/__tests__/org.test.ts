import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// org.ts resolves its org dir at CALL time from resolveJinnHome(), so
// the seam is the home (not the frozen ORG_DIR constant). tmpDir stays the org
// dir the fixtures are written into: <tmpHome>/org.
let tmpHome: string;
let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  resolveJinnHome: () => tmpHome,
}));

function makeTmpOrg(prefix: string) {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDir = path.join(tmpHome, "org");
  fs.mkdirSync(tmpDir, { recursive: true });
}

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { scanOrg } from "../org.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("scanOrg — alwaysNotify field", () => {
  beforeEach(() => {
    makeTmpOrg("org-test-");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("defaults alwaysNotify to true when not specified in YAML", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
`);
    const registry = scanOrg();
    const emp = registry.get("dev");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("parses alwaysNotify: false from YAML", () => {
    writeYaml("platform", "worker.yaml", `
name: worker
persona: A worker
alwaysNotify: false
`);
    const registry = scanOrg();
    const emp = registry.get("worker");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(false);
  });

  it("parses alwaysNotify: true from YAML", () => {
    writeYaml("platform", "lead.yaml", `
name: lead
persona: A lead
alwaysNotify: true
`);
    const registry = scanOrg();
    const emp = registry.get("lead");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });

  it("ignores non-boolean alwaysNotify values and defaults to true", () => {
    writeYaml("platform", "bad.yaml", `
name: bad
persona: A bad config
alwaysNotify: "yes"
`);
    const registry = scanOrg();
    const emp = registry.get("bad");
    expect(emp).toBeDefined();
    expect(emp!.alwaysNotify).toBe(true);
  });
});

describe("scanOrg — jinnMcp per-employee override (GRS-017e-fix, live-QA phase-D catch)", () => {
  beforeEach(() => {
    makeTmpOrg("org-test-");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("parses jinnMcp: true/false from the employee YAML (the scan whitelist previously dropped it — a YAML pilot could never arm the smoke gate)", () => {
    writeYaml("platform", "pilot.yaml", `
name: pilot
persona: pilot employee
jinnMcp: true
`);
    writeYaml("platform", "optout.yaml", `
name: optout
persona: opted-out employee
jinnMcp: false
`);
    const registry = scanOrg();
    expect(registry.get("pilot")!.jinnMcp).toBe(true);
    expect(registry.get("optout")!.jinnMcp).toBe(false);
  });

  it("leaves jinnMcp undefined when absent or non-boolean (follow the global setting)", () => {
    writeYaml("platform", "plain.yaml", `
name: plain
persona: plain employee
`);
    writeYaml("platform", "bad.yaml", `
name: badjinn
persona: bad value
jinnMcp: "yes"
`);
    const registry = scanOrg();
    expect(registry.get("plain")!.jinnMcp).toBeUndefined();
    expect(registry.get("badjinn")!.jinnMcp).toBeUndefined();
  });
});

describe("scanOrg — closeTodos field", () => {
  beforeEach(() => {
    makeTmpOrg("org-test-close-todos-");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reads closeTodos: true as the grant, and nothing else as one", () => {
    writeYaml("ops", "closer.yaml", "name: closer\npersona: closes\ncloseTodos: true\n");
    writeYaml("ops", "absent.yaml", "name: absent\npersona: no field\n");
    writeYaml("ops", "off.yaml", "name: off\npersona: explicitly off\ncloseTodos: false\n");
    for (const [name, value] of [["quoted", '"true"'], ["number", "1"], ["word", "yes"]]) {
      writeYaml("ops", `${name}.yaml`, `name: ${name}\npersona: ${name} value\ncloseTodos: ${value}\n`);
    }

    const registry = scanOrg();

    expect(registry.get("closer")!.closeTodos).toBe(true);
    for (const name of ["absent", "off", "quoted", "number", "word"]) {
      expect(registry.get(name)!.closeTodos, name).toBeUndefined();
    }
  });
});

describe("scanOrg — reserved author identities", () => {
  beforeEach(() => {
    makeTmpOrg("org-test-reserved-");
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("skips employees whose name collides with the operator/system/session author namespaces and keeps scanning", async () => {
    const { logger } = await import("../../shared/logger.js");
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();
    writeYaml("platform", "operator.yaml", "name: Operator\npersona: sentinel impostor\n");
    writeYaml("platform", "system.yaml", "name: system\npersona: sentinel impostor\n");
    writeYaml("platform", "session.yaml", 'name: "session:0a1b2c3d"\npersona: sentinel impostor\n');
    // Todos v2 slice 5: cron:<jobId> and workflow:<defId> are creator
    // identities too — same reservation.
    writeYaml("platform", "cron.yaml", 'name: "cron:nightly"\npersona: sentinel impostor\n');
    writeYaml("platform", "workflow.yaml", 'name: "workflow:release"\npersona: sentinel impostor\n');
    writeYaml("platform", "dev.yaml", "name: dev\npersona: A developer\n");

    const registry = scanOrg();
    expect(registry.get("dev")).toBeDefined();
    // dev, plus the two compiled-in system employees.
    expect(registry.size).toBe(3);
    expect(registry.has("Operator")).toBe(false);
    expect(registry.has("system")).toBe(false);
    expect(registry.has("session:0a1b2c3d")).toBe(false);
    expect(registry.has("cron:nightly")).toBe(false);
    expect(registry.has("workflow:release")).toBe(false);

    const warnings = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => /reserved author identity/i.test(w))).toHaveLength(5);
  });
});
