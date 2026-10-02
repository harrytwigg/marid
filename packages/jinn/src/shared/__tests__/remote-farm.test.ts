import { describe, expect, it } from "vitest";
import { FARM_SCRIPT } from "../../engines/remote-stage.js";
import { FARM_FILTERED_DIRS, isFarmExcludedChild, isLinkedInFarm, REMOTE_STAGE_MARKER } from "../remote-farm.js";

describe("remote-farm layout", () => {
  it("excludes database files, their sidecars and backups/", () => {
    for (const name of ["registry.db", "registry.db-wal", "registry.db-shm", "registry.db-journal", "workflows.db", "backups"]) {
      expect(isFarmExcludedChild(name)).toBe(true);
    }
    for (const name of ["registry.db.version", "restart-interrupted.jsonl", "abc123", "notes.dbx"]) {
      expect(isFarmExcludedChild(name)).toBe(false);
    }
  });

  it("says which gateway-home paths the farm links", () => {
    expect(isLinkedInFarm(["knowledge", "a.md"])).toBe(true);
    expect(isLinkedInFarm(["uploads", "2026-10-02", "s", "a.png"])).toBe(true);
    expect(isLinkedInFarm(["sessions", "restart-interrupted.jsonl"])).toBe(true);
    expect(isLinkedInFarm(["sessions", "abc", "pi-session", "x.json"])).toBe(true);
    expect(isLinkedInFarm(["tmp", "photo.jpg"])).toBe(false);
    expect(isLinkedInFarm(["gateway.json"])).toBe(false);
    expect(isLinkedInFarm([REMOTE_STAGE_MARKER])).toBe(false);
    expect(isLinkedInFarm(["sessions", "registry.db"])).toBe(false);
    expect(isLinkedInFarm(["sessions", "registry.db-wal"])).toBe(false);
    expect(isLinkedInFarm(["sessions", "backups", "registry.db.pre-x"])).toBe(false);
    expect(isLinkedInFarm(["workflows", "workflows.db"])).toBe(false);
    expect(isLinkedInFarm(["sessions"])).toBe(false);
    expect(isLinkedInFarm([])).toBe(false);
  });

  it("is the layout FARM_SCRIPT actually builds", () => {
    for (const dir of FARM_FILTERED_DIRS) expect(FARM_SCRIPT).toContain(dir);
    expect(FARM_SCRIPT).toContain(REMOTE_STAGE_MARKER);
    expect(FARM_SCRIPT).toContain("backups|*.db|*.db-wal|*.db-shm|*.db-journal");
  });
});
