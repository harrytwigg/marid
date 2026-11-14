import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";
import { readManifest } from "../manifest.js";
import { restoreSnapshot } from "../restore.js";
import { createSnapshot } from "../snapshot.js";
import { HOME_CONTENT, makeHome, registryRowCount } from "./fixture.js";

const scratch: string[] = [];
const AT = new Date("2026-08-20T03:00:00.000Z");

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-backup-restore-"));
  scratch.push(dir);
  return dir;
}

const sha = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function snapshotOf(root: string, rows = 23): Promise<{ home: string; snapshot: string }> {
  const home = makeHome(root, "alpha", { registryRows: rows });
  const report = await createSnapshot({ name: "alpha", home }, path.join(root, "backups"), AT);
  expect(report.status).toBe("ok");
  return { home, snapshot: report.path };
}

/** A home whose registry was never there, so its snapshot carries none. */
async function registrylessSnapshotOf(root: string): Promise<string> {
  const home = makeHome(root, "alpha");
  fs.rmSync(path.join(home, "sessions"), { recursive: true, force: true });
  const report = await createSnapshot({ name: "alpha", home }, path.join(root, "backups"), AT);
  expect(report.status).toBe("ok");
  return report.path;
}

/** The three files a live registry occupies in a home about to be restored over. */
const REGISTRY_FILES = ["registry.db", "registry.db-wal", "registry.db-shm"];

function seedRegistry(home: string): void {
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  for (const name of REGISTRY_FILES) fs.writeFileSync(path.join(home, "sessions", name), `previous ${name}\n`);
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("restoreSnapshot", () => {
  it("reproduces every archived file byte for byte", async () => {
    const root = tempDir();
    const { home, snapshot } = await snapshotOf(root);
    const restored = path.join(tempDir(), "home");

    await restoreSnapshot({ snapshot, home: restored });

    for (const relative of Object.keys(HOME_CONTENT)) {
      const target = path.join(restored, relative);
      expect(fs.existsSync(target), relative).toBe(true);
      expect(sha(target), relative).toBe(sha(path.join(home, relative)));
    }
  });

  it("restores sessions/registry.db with every row the source held", async () => {
    const root = tempDir();
    const { snapshot } = await snapshotOf(root, 23);
    const restored = path.join(tempDir(), "home");

    const result = await restoreSnapshot({ snapshot, home: restored });

    expect(result.restoredRegistry).toBe(true);
    const registry = path.join(restored, "sessions", "registry.db");
    expect(registryRowCount(registry)).toBe(23);
    expect(sha(registry)).toBe(readManifest(snapshot).files.find((f) => f.path === "registry.db")!.sha256);
  });

  it("verifies the manifest before extracting, leaving the home untouched", async () => {
    const root = tempDir();
    const { snapshot } = await snapshotOf(root);
    const archive = fs.readdirSync(snapshot).find((name) => name.startsWith("home."))!;
    fs.writeFileSync(path.join(snapshot, archive), "corrupted");
    const restored = path.join(tempDir(), "home");

    await expect(restoreSnapshot({ snapshot, home: restored })).rejects.toThrow(/failed verification/);
    expect(fs.existsSync(restored)).toBe(false);
  });

  it("refuses a non-empty home unless forced", async () => {
    const root = tempDir();
    const { snapshot } = await snapshotOf(root);
    const restored = path.join(tempDir(), "home");
    fs.mkdirSync(restored, { recursive: true });
    fs.writeFileSync(path.join(restored, "config.yaml"), "port: 1\n");

    await expect(restoreSnapshot({ snapshot, home: restored })).rejects.toThrow(/not empty/);

    await restoreSnapshot({ snapshot, home: restored, force: true });
    expect(fs.readFileSync(path.join(restored, "config.yaml"), "utf8")).toBe(HOME_CONTENT["config.yaml"]);
  });

  it("leaves nothing of the old home behind when restoring over it with --force", async () => {
    const root = tempDir();
    const { home, snapshot } = await snapshotOf(root);
    const restored = path.join(tempDir(), "home");
    fs.mkdirSync(path.join(restored, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(restored, "knowledge", "stale.md"), "not in the snapshot\n");
    fs.writeFileSync(path.join(restored, "config.yaml"), "port: 1\n");

    await restoreSnapshot({ snapshot, home: restored, force: true });

    // A file the snapshot does not have must not survive the restore, or the
    // result is a merge of two homes rather than a copy of one.
    expect(fs.existsSync(path.join(restored, "knowledge", "stale.md"))).toBe(false);
    for (const relative of Object.keys(HOME_CONTENT)) {
      expect(sha(path.join(restored, relative)), relative).toBe(sha(path.join(home, relative)));
    }
  });

  it("takes the registry and its sidecars with it when the snapshot carries none", async () => {
    const root = tempDir();
    const snapshot = await registrylessSnapshotOf(root);
    const restored = path.join(tempDir(), "home");
    seedRegistry(restored);
    fs.writeFileSync(path.join(restored, "sessions", "notes.json"), "{}\n");
    fs.mkdirSync(path.join(restored, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(restored, "workflows", "workflows.db"), "not this command's to delete\n");

    const result = await restoreSnapshot({ snapshot, home: restored, force: true });

    // Left in place, the previous occupant's sessions come back wearing the
    // restored instance's name - and a -wal beside a database that is gone is
    // read as the tail of whatever database turns up next.
    expect(result.restoredRegistry).toBe(false);
    for (const name of REGISTRY_FILES) {
      expect(fs.existsSync(path.join(restored, "sessions", name)), name).toBe(false);
    }
    expect(fs.existsSync(path.join(restored, "sessions", "notes.json"))).toBe(true);
    expect(fs.existsSync(path.join(restored, "workflows", "workflows.db"))).toBe(true);
  });

  it("replaces the registry it finds, sidecars included, with the snapshot's own", async () => {
    const root = tempDir();
    const { snapshot } = await snapshotOf(root, 23);
    const restored = path.join(tempDir(), "home");
    seedRegistry(restored);

    const result = await restoreSnapshot({ snapshot, home: restored, force: true });

    expect(result.restoredRegistry).toBe(true);
    const registry = path.join(restored, "sessions", "registry.db");
    // Before anything opens it: a WAL database writes its own sidecars back the
    // moment it is read, so this only means the old ones the moment restore ends.
    for (const sidecar of ["registry.db-wal", "registry.db-shm"]) {
      expect(fs.existsSync(path.join(restored, "sessions", sidecar)), sidecar).toBe(false);
    }
    if (POSIX_MODES_SUPPORTED) expectPosixMode(registry, 0o600);
    expect(registryRowCount(registry)).toBe(23);
  });

  it("refuses a home that still looks like a running instance", async () => {
    const root = tempDir();
    const { snapshot } = await snapshotOf(root);
    const restored = path.join(tempDir(), "home");
    fs.mkdirSync(restored, { recursive: true });
    fs.writeFileSync(path.join(restored, "gateway.json"), "{}");

    await expect(restoreSnapshot({ snapshot, home: restored, force: true })).rejects.toThrow(/running instance/);
  });
});
