import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-operator-turn-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  (await import("../../shared/db.js")).initDb();
});

describe("an attempt's operator-turn stamp", () => {
  it("starts unstamped on a new session", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:fresh" });
    expect(reg.getSession(s.id)?.attemptOperatorTurn).toBe(false);
  });

  it("is set only by the attempt that asks for it, and cleared by the next one that does not", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:stamp" });
    expect(reg.beginSessionAttempt(s.id, { attemptOperatorTurn: true })?.attemptOperatorTurn).toBe(true);
    expect(reg.getSession(s.id)?.attemptOperatorTurn).toBe(true);

    expect(reg.beginSessionAttempt(s.id)?.attemptOperatorTurn).toBe(false);
    expect(reg.getSession(s.id)?.attemptOperatorTurn).toBe(false);
  });

  it("survives updates within the attempt that do not name it", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:keep" });
    reg.beginSessionAttempt(s.id, { attemptOperatorTurn: true });
    reg.updateSession(s.id, { lastActivity: new Date().toISOString() });
    expect(reg.getSession(s.id)?.attemptOperatorTurn).toBe(true);
  });
});
