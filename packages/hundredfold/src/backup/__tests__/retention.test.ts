import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneSnapshots } from "../retention.js";

const scratch: string[] = [];
const NOW = new Date("2026-08-20T03:00:00.000Z");

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-backup-retention-"));
  scratch.push(dir);
  return dir;
}

function stamp(ageDays: number): string {
  return new Date(NOW.getTime() - ageDays * 86_400_000).toISOString().slice(0, 10);
}

/** A snapshot directory of a known size, so the total-size cap is testable. */
function seedSnapshot(root: string, instance: string, ageDays: number, bytes = 64): string {
  const dir = path.join(root, instance, stamp(ageDays));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "home.tar.gz"), "x".repeat(bytes));
  return dir;
}

const remaining = (root: string, instance: string): string[] =>
  fs.readdirSync(path.join(root, instance)).sort();

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pruneSnapshots", () => {
  it("removes only the dated snapshots past the window", () => {
    const root = tempDir();
    const ages = Array.from({ length: 16 }, (_, index) => index * 2);
    for (const age of ages) seedSnapshot(root, "alpha", age);

    const result = pruneSnapshots({ root, now: NOW, retentionDays: 14 });

    expect(remaining(root, "alpha")).toEqual(ages.filter((age) => age <= 14).map(stamp).sort());
    expect(result.removed).toHaveLength(8);
  });

  it("keeps the most recent snapshot even when it is older than the window", () => {
    const root = tempDir();
    seedSnapshot(root, "stale", 100);
    seedSnapshot(root, "stale", 200);

    pruneSnapshots({ root, now: NOW, retentionDays: 14 });

    expect(remaining(root, "stale")).toEqual([stamp(100)]);
  });

  it("ignores a directory whose name is not a date", () => {
    const root = tempDir();
    seedSnapshot(root, "alpha", 0);
    seedSnapshot(root, "alpha", 90);
    fs.mkdirSync(path.join(root, "alpha", "latest"), { recursive: true });
    fs.mkdirSync(path.join(root, "alpha", "2026-13-99"), { recursive: true });

    pruneSnapshots({ root, now: NOW, retentionDays: 14 });

    expect(remaining(root, "alpha")).toEqual(["2026-13-99", stamp(0), "latest"].sort());
  });

  it("never follows a dated symlink out of the backup root", () => {
    const root = tempDir();
    const outside = tempDir();
    const treasure = path.join(outside, "keep-me.txt");
    fs.writeFileSync(treasure, "irreplaceable\n");
    seedSnapshot(root, "alpha", 0);
    const link = path.join(root, "alpha", stamp(99));
    fs.symlinkSync(outside, link);

    const result = pruneSnapshots({ root, now: NOW, retentionDays: 14 });

    expect(fs.existsSync(treasure)).toBe(true);
    expect(fs.readdirSync(outside)).toEqual(["keep-me.txt"]);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([link]);
    fs.unlinkSync(link);
  });

  it("prunes oldest-first across every instance once the total-size cap is passed", () => {
    const root = tempDir();
    seedSnapshot(root, "alpha", 0, 100);
    seedSnapshot(root, "alpha", 1, 100);
    seedSnapshot(root, "beta", 2, 100);
    seedSnapshot(root, "beta", 3, 100);

    const result = pruneSnapshots({ root, now: NOW, retentionDays: 14, maxTotalBytes: 300 });

    // Oldest first, but each instance keeps its newest whatever the cap says.
    expect(remaining(root, "alpha")).toEqual([stamp(0), stamp(1)].sort());
    expect(remaining(root, "beta")).toEqual([stamp(2)]);
    expect(result.removed).toEqual([path.join(root, "beta", stamp(3))]);
  });

  it("reports what it could not fit rather than failing when the cap cannot be met", () => {
    const root = tempDir();
    seedSnapshot(root, "alpha", 0, 500);
    seedSnapshot(root, "beta", 1, 500);

    const result = pruneSnapshots({ root, now: NOW, retentionDays: 14, maxTotalBytes: 100 });

    expect(result.keptBytes).toBe(1000);
    expect(result.overCap).toBe(true);
    expect(remaining(root, "alpha")).toEqual([stamp(0)]);
    expect(remaining(root, "beta")).toEqual([stamp(1)]);
  });

  it("does nothing when the backup root does not exist yet", () => {
    const root = path.join(tempDir(), "never-created");
    expect(pruneSnapshots({ root, now: NOW, retentionDays: 14 })).toEqual({
      removed: [], skipped: [], keptBytes: 0, overCap: false,
    });
  });
});
