import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fallback-store-"));
process.env.JINN_HOME = tmp;
const migrate = await import("../migrate.js");
const reg = await import("../registry.js");
const dbModule = await import("../../shared/db.js");

describe("sessions.fallback_mode storage", () => {
  it("is added to an existing sessions table as a nullable column, leaving old rows NULL", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, engine TEXT NOT NULL, engine_session_id TEXT, source TEXT NOT NULL,
      source_ref TEXT NOT NULL, employee TEXT, model TEXT, status TEXT DEFAULT 'idle', created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL, last_error TEXT);
      INSERT INTO sessions (id, engine, source, source_ref, created_at, last_activity) VALUES ('old', 'claude', 'web', 'r', 'x', 'x');`);
    migrate.migrateSessionsSchema(db);
    const col = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string; notnull: number }>).find((c) => c.name === "fallback_mode");
    expect(col).toMatchObject({ notnull: 0 });
    expect((db.prepare("SELECT fallback_mode FROM sessions WHERE id = 'old'").get() as { fallback_mode: string | null }).fallback_mode).toBeNull();
  });

  it("a created session stores its mode, and a root stores NULL", () => {
    const withMode = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:a", fallbackMode: "auto-resume" });
    const root = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:b" });
    expect(withMode.fallbackMode).toBe("auto-resume");
    expect(reg.getSession(withMode.id)?.fallbackMode).toBe("auto-resume");
    expect(root.fallbackMode).toBeNull();
    expect(reg.getSession(root.id)?.fallbackMode).toBeNull();
  });

  it("updateSession changes it and survives closing and re-opening the database", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:c" });
    expect(reg.updateSession(s.id, { fallbackMode: "fallback-children" })?.fallbackMode).toBe("fallback-children");
    dbModule.__closeDbForTest();
    expect(reg.getSession(s.id)?.fallbackMode).toBe("fallback-children");
    reg.updateSession(s.id, { title: "renamed" });
    expect(reg.getSession(s.id)?.fallbackMode).toBe("fallback-children");
    expect(reg.updateSession(s.id, { fallbackMode: null })?.fallbackMode).toBeNull();
  });

  it("a stored value outside the three modes reads as NULL", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:d" });
    dbModule.initDb().prepare("UPDATE sessions SET fallback_mode = 'bogus' WHERE id = ?").run(s.id);
    expect(reg.getSession(s.id)?.fallbackMode).toBeNull();
  });

  it("a duplicate keeps the source's mode", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:e", fallbackMode: "auto-resume" });
    reg.recordEngineSessionId(s.id, "claude", "claude-native-1");
    expect(reg.duplicateSession(s.id).session.fallbackMode).toBe("auto-resume");
  });
});
