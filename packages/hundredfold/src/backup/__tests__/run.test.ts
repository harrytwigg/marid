import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_DIRECTORY_SCHEMA_VERSION } from "../../instances/directory.js";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";
import { runBackup } from "../../cli/backup.js";
import { resolveArchiveCodec, type ArchiveCodec } from "../codec.js";
import { readManifest } from "../manifest.js";
import { restoreSnapshot } from "../restore.js";
import { runBackupRun } from "../run.js";
import { makeHome } from "./fixture.js";

/**
 * A codec whose compressor is the Node running the suite.
 *
 * These fakes misbehave in ways no installed tool offers, and naming a real
 * binary by absolute path would pin the suite to one platform's layout. Each
 * decodes with a plain copy, so reading the archive back measures exactly what
 * the compressor chose to write.
 */
const fakeCodec = (compress: string): ArchiveCodec => ({
  id: "gzip",
  extension: "tar.gz",
  command: process.execPath,
  compressArgs: ["-e", compress],
  decompressArgs: ["-e", "process.stdin.pipe(process.stdout)"],
});

/** Consumes all of tar's output and emits nothing, so the archive lands empty
 *  while both processes still exit 0 - a full disk, without needing one. */
const EMPTY_ARCHIVE_CODEC = fakeCodec("process.stdin.resume()");

/** Reads a little, then exits while tar is still writing: the classic EPIPE. */
const EARLY_EXIT_CODEC = fakeCodec("process.stdin.once('data', () => process.exit(0))");

/** Reads every last byte and writes only the head of it, so tar sees a reader
 *  that never breaks and both processes exit 0 over a gutted archive. */
const TRUNCATED_ARCHIVE_CODEC = fakeCodec(
  "let read = 0;"
  + "process.stdin.on('data', (chunk) => {"
  + "  if (read < 512) process.stdout.write(chunk.subarray(0, 512 - read));"
  + "  read += chunk.length;"
  + "});",
);

const scratch: string[] = [];
const AT = new Date("2026-08-20T03:00:00.000Z");

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-backup-run-"));
  scratch.push(dir);
  return dir;
}

function writeRegistry(root: string, homes: Record<string, string>): string {
  const registryPath = path.join(root, "instances.json");
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: INSTANCE_DIRECTORY_SCHEMA_VERSION,
    instances: Object.entries(homes).map(([name, home], index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      name, port: 7900 + index, home, createdAt: "2020-01-01T00:00:00.000Z", kind: "workspace", pinned: true,
    })),
  }, null, 2));
  return registryPath;
}

/** A two-home registry, the second of which is left in a state that fails. */
function twoHomes(root: string, options: { breakSecond?: boolean } = {}): string {
  const alpha = makeHome(root, "alpha");
  const beta = makeHome(root, "beta");
  if (options.breakSecond) fs.writeFileSync(path.join(beta, "sessions", "registry.db"), "not a database");
  return writeRegistry(root, { alpha, beta });
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runBackupRun", () => {
  it("snapshots every target in the registry", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);
    const backups = path.join(root, "backups");

    const result = await runBackupRun({ root: backups, now: AT, registryPath });

    expect(result.status).toBe("ok");
    expect(result.targets.map((target) => target.name)).toEqual(["alpha", "beta"]);
    for (const target of result.targets) {
      expect(target.status).toBe("ok");
      expect(target.bytes).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(target.path, "manifest.json"))).toBe(true);
    }
  });

  it("emits exactly the per-target fields the alerting job reads", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root, { breakSecond: true });

    const result = await runBackupRun({ root: path.join(root, "backups"), now: AT, registryPath });

    for (const target of result.targets) {
      expect(Object.keys(target).sort()).toEqual(
        target.status === "ok" ? ["bytes", "name", "path", "status"] : ["bytes", "error", "name", "path", "status"],
      );
    }
  });

  it("keeps going after a failing target and reports the run as failed", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root, { breakSecond: true });
    const backups = path.join(root, "backups");

    const result = await runBackupRun({ root: backups, now: AT, registryPath });

    expect(result.status).toBe("failed");
    const [alpha, beta] = result.targets;
    expect(beta!.status).toBe("failed");
    // The healthy target's snapshot is intact and complete, not a casualty.
    expect(alpha!.status).toBe("ok");
    expect(fs.readdirSync(alpha!.path).sort())
      .toEqual([`home.${resolveArchiveCodec().extension}`, "manifest.json", "registry.db"]);
  });

  it("prunes even when a target failed", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root, { breakSecond: true });
    const backups = path.join(root, "backups");
    const ancient = path.join(backups, "alpha", "2020-01-01");
    fs.mkdirSync(ancient, { recursive: true });
    fs.writeFileSync(path.join(ancient, "home.tar.gz"), "old");

    const result = await runBackupRun({ root: backups, now: AT, registryPath, retentionDays: 14 });

    expect(result.status).toBe("failed");
    expect(result.retention.removed).toContain(ancient);
    expect(fs.existsSync(ancient)).toBe(false);
  });

  it("marks a target failed when its archive comes out empty", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);

    const result = await runBackupRun({
      root: path.join(root, "backups"), now: AT, registryPath, codec: EMPTY_ARCHIVE_CODEC,
    });

    expect(result.status).toBe("failed");
    for (const target of result.targets) {
      expect(target.status, target.name).toBe("failed");
      expect(target.error, target.name).toMatch(/reads back as 0 of \d+ bytes/);
      expect(fs.existsSync(target.path), target.name).toBe(false);
    }
  });

  it("marks a target failed when its archive comes out truncated", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);

    const result = await runBackupRun({
      root: path.join(root, "backups"), now: AT, registryPath, codec: TRUNCATED_ARCHIVE_CODEC,
    });

    // Nothing in the pipeline can see this one: tar exits 0, the codec exits 0,
    // and the file it left is neither empty nor corrupt on its face. Only
    // decoding it says how much of the home actually made it in.
    expect(result.status).toBe("failed");
    for (const target of result.targets) {
      expect(target.status, target.name).toBe("failed");
      expect(target.error, target.name).toMatch(/reads back as 512 of \d+ bytes/);
      expect(fs.existsSync(target.path), target.name).toBe(false);
    }
  });

  it("fails the target rather than the process when the compressor exits early", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);
    // Larger than a pipe buffer, so tar is still writing when the compressor is
    // already gone. Below that the whole stream fits in the buffer, the write
    // never lands on a closed pipe, and there is no EPIPE to survive.
    fs.writeFileSync(path.join(root, "alpha", "knowledge", "bulk.md"), "x".repeat(4 * 1024 * 1024));

    // Reaching the assertions at all is the point: an unhandled EPIPE on the
    // pipe into the compressor takes down the whole Node process instead.
    const result = await runBackupRun({
      root: path.join(root, "backups"), now: AT, registryPath, codec: EARLY_EXIT_CODEC,
    });

    expect(result.status).toBe("failed");
    expect(result.targets).toHaveLength(2);
    for (const target of result.targets) expect(target.status, target.name).toBe("failed");
  });

  it("keeps going past a failing target and still snapshots the ones behind it", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);
    const backups = path.join(root, "backups");
    // A stale file where alpha's directory belongs: the FIRST target fails, so
    // a run that stopped at the first failure could not produce beta at all.
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, "alpha"), "not a directory");

    const result = await runBackupRun({ root: backups, now: AT, registryPath });

    const [alpha, beta] = result.targets;
    expect(alpha!.name).toBe("alpha");
    expect(alpha!.status).toBe("failed");
    expect(beta!.name).toBe("beta");
    expect(beta!.status).toBe("ok");
    expect(fs.existsSync(path.join(beta!.path, "manifest.json"))).toBe(true);
    expect(result.status).toBe("failed");
  });

  it("exits non-zero from the CLI when any target failed", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);
    const backups = path.join(root, "backups");
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, "alpha"), "not a directory");

    const previousExitCode = process.exitCode;
    const previousRegistry = process.env.HUNDREDFOLD_INSTANCES_REGISTRY;
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => { logged.push(line); });
    process.env.HUNDREDFOLD_INSTANCES_REGISTRY = registryPath;
    process.exitCode = 0;
    try {
      await runBackup({ root: backups, json: true });
      expect(process.exitCode).toBe(1);
      const report = JSON.parse(logged.join("")) as { status: string; targets: { name: string; status: string }[] };
      expect(report.status).toBe("failed");
      expect(report.targets.find((target) => target.name === "beta")!.status).toBe("ok");
    } finally {
      log.mockRestore();
      process.exitCode = previousExitCode;
      if (previousRegistry === undefined) delete process.env.HUNDREDFOLD_INSTANCES_REGISTRY;
      else process.env.HUNDREDFOLD_INSTANCES_REGISTRY = previousRegistry;
    }
  });

  it("runs the whole gzip branch end to end, naming the codec in the manifest", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);
    const gzip = resolveArchiveCodec((name) => name === "gzip");
    expect(gzip.id).toBe("gzip");

    const result = await runBackupRun({ root: path.join(root, "backups"), now: AT, registryPath, codec: gzip });

    expect(result.status).toBe("ok");
    expect(result.codec).toBe("gzip");
    const snapshot = result.targets[0]!.path;
    expect(fs.existsSync(path.join(snapshot, "home.tar.gz"))).toBe(true);
    expect(readManifest(snapshot).codec).toBe("gzip");

    // Restore reads the codec from the manifest, not from the file name.
    const restored = path.join(tempDir(), "home");
    await restoreSnapshot({ snapshot, home: restored });
    expect(fs.readFileSync(path.join(restored, "config.yaml"), "utf8")).toBe("port: 7901\n");
  });

  it.skipIf(!POSIX_MODES_SUPPORTED)("creates the backup root owner-only", async () => {
    const root = tempDir();
    const registryPath = twoHomes(root);
    const backups = path.join(root, "backups");
    const previousUmask = process.umask(0);
    try {
      await runBackupRun({ root: backups, now: AT, registryPath });
      expectPosixMode(backups, 0o700);
    } finally {
      process.umask(previousUmask);
    }
  });
});
