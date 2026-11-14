import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupSqliteDatabase } from "../sqlite-backup.js";

const scratch: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-backup-sqlite-"));
  scratch.push(dir);
  return dir;
}

/**
 * A WAL database whose rows are still in the -wal sidecar: nothing has
 * checkpointed, which is exactly the state a live gateway's registry.db is in.
 */
function openLiveDatabase(file: string, rows: number): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO entries (payload) VALUES (?)");
  const seed = db.transaction((count: number) => {
    for (let i = 0; i < count; i += 1) insert.run("x".repeat(512));
  });
  seed(rows);
  return db;
}

const countRows = (db: Database.Database): number =>
  (db.prepare("SELECT count(*) AS n FROM entries").get() as { n: number }).n;

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("backupSqliteDatabase", () => {
  it("copies a live WAL database that is being written to, intact and complete", async () => {
    const dir = tempDir();
    const source = path.join(dir, "registry.db");
    const destination = path.join(dir, "copy.db");
    const db = openLiveDatabase(source, 2000);
    const insert = db.prepare("INSERT INTO entries (payload) VALUES (?)");

    // Write from inside the backup's own progress callback, so the writes are
    // guaranteed to land between backup steps rather than racing a timer.
    let writesLeft = 20;
    try {
      await backupSqliteDatabase(source, destination, () => {
        if (writesLeft > 0) {
          insert.run(`concurrent-${writesLeft}`);
          writesLeft -= 1;
        }
      });
      expect(writesLeft).toBe(0);

      const expected = countRows(db);
      expect(expected).toBe(2020);

      const copy = new Database(destination, { readonly: true, fileMustExist: true });
      try {
        expect((copy.pragma("integrity_check") as { integrity_check: string }[])[0]!.integrity_check).toBe("ok");
        expect(countRows(copy)).toBe(expected);
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });

  it("refuses a destination outside the snapshot directory it was handed", async () => {
    const dir = tempDir();
    const source = path.join(dir, "registry.db");
    const db = openLiveDatabase(source, 1);
    try {
      await expect(backupSqliteDatabase(source, path.join(dir, "nested", "copy.db")))
        .resolves.toBeGreaterThan(0);
    } finally {
      db.close();
    }
    expect(fs.existsSync(path.join(dir, "nested", "copy.db"))).toBe(true);
  });
});
