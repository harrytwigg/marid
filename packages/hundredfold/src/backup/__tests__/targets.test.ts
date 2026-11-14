import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTANCE_DIRECTORY_SCHEMA_VERSION } from "../../instances/directory.js";
import { resolveBackupTargets } from "../targets.js";

const scratch: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-backup-targets-"));
  scratch.push(dir);
  return dir;
}

/** Writes a schemaVersion-2 registry naming every home, and returns its path. */
function writeRegistry(root: string, homes: Record<string, string>): string {
  const registryPath = path.join(root, "instances.json");
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: INSTANCE_DIRECTORY_SCHEMA_VERSION,
    instances: Object.entries(homes).map(([name, home], index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      name,
      port: 7900 + index,
      home,
      createdAt: "2020-01-01T00:00:00.000Z",
      kind: "workspace",
      pinned: true,
    })),
  }, null, 2));
  return registryPath;
}

function makeHome(root: string, name: string, options: { configYaml?: boolean } = {}): string {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  if (options.configYaml !== false) fs.writeFileSync(path.join(home, "config.yaml"), "port: 7900\n");
  return home;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveBackupTargets", () => {
  it("returns only the registry instances whose home exists and holds a config.yaml", () => {
    const root = tempDir();
    const live = makeHome(root, "alpha");
    const notAHome = makeHome(root, "beta", { configYaml: false });
    const registryPath = writeRegistry(root, {
      alpha: live,
      beta: notAHome,
      gamma: path.join(root, "deleted-home"),
    });

    expect(resolveBackupTargets({ registryPath })).toEqual([{ name: "alpha", home: live }]);
  });

  it("reads the registry named by HUNDREDFOLD_INSTANCES_REGISTRY", () => {
    const root = tempDir();
    const live = makeHome(root, "delta");
    const registryPath = writeRegistry(root, { delta: live });
    const previous = process.env.HUNDREDFOLD_INSTANCES_REGISTRY;
    process.env.HUNDREDFOLD_INSTANCES_REGISTRY = registryPath;
    try {
      expect(resolveBackupTargets()).toEqual([{ name: "delta", home: live }]);
    } finally {
      if (previous === undefined) delete process.env.HUNDREDFOLD_INSTANCES_REGISTRY;
      else process.env.HUNDREDFOLD_INSTANCES_REGISTRY = previous;
    }
  });

  it("skips a home whose config.yaml is a directory rather than a file", () => {
    const root = tempDir();
    const home = makeHome(root, "epsilon", { configYaml: false });
    fs.mkdirSync(path.join(home, "config.yaml"));
    const registryPath = writeRegistry(root, { epsilon: home });

    expect(resolveBackupTargets({ registryPath })).toEqual([]);
  });
});
