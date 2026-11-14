import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// HUNDREDFOLD_HOME has to be set before anything reaches paths.js, which reads it once.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-plugin-storage-"));
process.env.HUNDREDFOLD_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });

let pluginStorage: (typeof import("../storage.js"))["pluginStorage"];

beforeAll(async () => {
  ({ pluginStorage } = await import("../storage.js"));
  (await import("../../shared/db.js")).initDb();
});

beforeEach(async () => {
  (await import("../../shared/db.js")).initDb().prepare("DELETE FROM plugin_kv").run();
});

describe("pluginStorage", () => {
  it("round-trips JSON values and reports an unwritten key as undefined", () => {
    const inbox = pluginStorage("inbox");
    inbox.set("draft", { subject: "Hello", unread: 3 });
    inbox.set("count", 0);
    inbox.set("empty", null);

    expect(inbox.get("draft")).toEqual({ subject: "Hello", unread: 3 });
    // Falsy values are stored values, not absences.
    expect(inbox.get("count")).toBe(0);
    expect(inbox.get("empty")).toBeNull();
    expect(inbox.get("never-written")).toBeUndefined();
  });

  it("overwrites a key rather than accumulating rows", () => {
    const inbox = pluginStorage("inbox");
    inbox.set("cursor", 1);
    inbox.set("cursor", 2);
    expect(inbox.get("cursor")).toBe(2);
    expect(inbox.keys()).toEqual(["cursor"]);
  });

  it("keeps two plugins writing the same key apart", () => {
    const inbox = pluginStorage("inbox");
    const notes = pluginStorage("notes");
    inbox.set("note", "inbox's own");
    notes.set("note", "notes' own");

    expect(inbox.get("note")).toBe("inbox's own");
    expect(notes.get("note")).toBe("notes' own");
    expect(inbox.keys()).toEqual(["note"]);
    expect(notes.keys()).toEqual(["note"]);
  });

  it("leaves the other plugin's key intact when one deletes its own", () => {
    const inbox = pluginStorage("inbox");
    const notes = pluginStorage("notes");
    inbox.set("note", "inbox's own");
    notes.set("note", "notes' own");

    inbox.delete("note");
    expect(inbox.get("note")).toBeUndefined();
    expect(inbox.keys()).toEqual([]);
    expect(notes.get("note")).toBe("notes' own");
  });

  it("takes no plugin id from the caller — there is nowhere in the interface to put one", () => {
    const storage = pluginStorage("inbox") as unknown as Record<string, (...args: unknown[]) => unknown>;
    // Namespacing is by construction: the id is closed over, so these arities are
    // the whole surface a plugin can reach and none of them accepts a namespace.
    expect(Object.keys(storage).sort()).toEqual(["delete", "get", "keys", "set"]);
    expect([storage.get.length, storage.set.length, storage.delete.length, storage.keys.length]).toEqual([1, 2, 1, 0]);
  });

  it("says so when a value cannot be JSON-encoded, rather than failing at the bind", () => {
    const inbox = pluginStorage("inbox");
    expect(() => inbox.set("fn", () => 1)).toThrow(/JSON-serializable/);
    expect(inbox.keys()).toEqual([]);
  });
});
