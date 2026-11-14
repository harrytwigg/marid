import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";
import { resolveArchiveCodec } from "../codec.js";
import { readManifest } from "../manifest.js";
import { createSnapshot } from "../snapshot.js";
import { HOME_CONTENT, makeHome, registryRowCount } from "./fixture.js";

const scratch: string[] = [];
const AT = new Date("2026-08-20T03:00:00.000Z");

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-backup-snapshot-"));
  scratch.push(dir);
  return dir;
}

function archiveEntries(snapshot: string, codecExtension: string): string[] {
  const archive = path.join(snapshot, `home.${codecExtension}`);
  const listing = execFileSync("tar", ["-tf", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // Windows tar -tf emits CRLF; POSIX tests compare against slash paths without CR.
  return listing.split("\n").filter(Boolean).map((entry) => entry.replace(/^\.\//, "").replace(/\r$/, ""));
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createSnapshot", () => {
  it("writes the archive, the registry copy and a manifest under a dated directory", async () => {
    const root = tempDir();
    const codec = resolveArchiveCodec();
    const home = makeHome(root, "alpha");

    const report = await createSnapshot({ name: "alpha", home }, path.join(root, "backups"), AT, codec);

    expect(report.status).toBe("ok");
    expect(report.path).toBe(path.join(root, "backups", "alpha", "2026-08-20"));
    expect(fs.readdirSync(report.path).sort()).toEqual([`home.${codec.extension}`, "manifest.json", "registry.db"]);
    expect(report.bytes).toBeGreaterThan(0);
  });

  it("archives the content of a home and none of its reproducible bulk", async () => {
    const root = tempDir();
    const codec = resolveArchiveCodec();
    const home = makeHome(root, "alpha");

    const report = await createSnapshot({ name: "alpha", home }, path.join(root, "backups"), AT, codec);
    const entries = archiveEntries(report.path, codec.extension);

    for (const kept of Object.keys(HOME_CONTENT)) expect(entries, kept).toContain(kept);
    for (const directory of ["org", "knowledge", "skills", "cron", "docs", "secrets"]) {
      expect(entries, directory).toContain(`${directory}/`);
    }
    for (const excluded of ["node_modules", "tmp", "uploads", ".git", ".venv", "__pycache__"]) {
      const leaked = entries.filter((entry) => entry.split("/").includes(excluded));
      expect(leaked, excluded).toEqual([]);
    }
  });

  it("records the codec, per-file sha256 and both byte counts", async () => {
    const root = tempDir();
    const codec = resolveArchiveCodec();
    const home = makeHome(root, "alpha");

    const report = await createSnapshot({ name: "alpha", home }, path.join(root, "backups"), AT, codec);
    const manifest = readManifest(report.path);

    expect(manifest.codec).toBe(codec.id);
    expect(manifest.instance).toBe("alpha");
    expect(manifest.uncompressedBytes).toBeGreaterThan(manifest.compressedBytes);
    expect(manifest.files.map((file) => file.path).sort()).toEqual([`home.${codec.extension}`, "registry.db"]);
    for (const file of manifest.files) {
      expect(file.sha256, file.path).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes, file.path).toBe(fs.statSync(path.join(report.path, file.path)).size);
    }
  });

  it("copies every registry row, including the ones a plain file copy would lose", async () => {
    const root = tempDir();
    const home = makeHome(root, "alpha", { registryRows: 41 });

    const report = await createSnapshot({ name: "alpha", home }, path.join(root, "backups"), AT);

    expect(registryRowCount(path.join(report.path, "registry.db"))).toBe(41);
  });

  it("reports the target failed rather than throwing when the registry is not a database", async () => {
    const root = tempDir();
    const home = makeHome(root, "alpha");
    fs.writeFileSync(path.join(home, "sessions", "registry.db"), "not a database at all");

    const report = await createSnapshot({ name: "alpha", home }, path.join(root, "backups"), AT);

    expect(report.status).toBe("failed");
    expect(report.error).toBeTruthy();
    expect(fs.existsSync(report.path)).toBe(false);
  });

  it("leaves no half-written snapshot directory behind when a target fails", async () => {
    const root = tempDir();
    const backups = path.join(root, "backups");
    const home = makeHome(root, "alpha");
    fs.writeFileSync(path.join(home, "sessions", "registry.db"), "not a database at all");

    await createSnapshot({ name: "alpha", home }, backups, AT);

    expect(fs.readdirSync(path.join(backups, "alpha"))).toEqual([]);
  });

  it.skipIf(!POSIX_MODES_SUPPORTED)("writes an owner-only tree, because the archive carries secrets/", async () => {
    const root = tempDir();
    const backups = path.join(root, "backups");
    const home = makeHome(root, "alpha");
    const previousUmask = process.umask(0);
    try {
      const report = await createSnapshot({ name: "alpha", home }, backups, AT);
      expectPosixMode(path.join(backups, "alpha"), 0o700);
      for (const file of fs.readdirSync(report.path)) expectPosixMode(path.join(report.path, file), 0o600);
    } finally {
      process.umask(previousUmask);
    }
  });
});
