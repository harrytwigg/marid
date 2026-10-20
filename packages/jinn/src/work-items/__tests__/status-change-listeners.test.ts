import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-status-listeners-"));

let store: typeof import("../store.js");
let transitions: typeof import("../transitions.js");
beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  transitions.setTodoStatusChangeListener(null);
  while (cleanups.length > 0) cleanups.pop()!();
});

const executing = () => store.createWorkItem({ title: "listened to", status: "executing", source: "session" });

describe("Todo status-change listeners", () => {
  it("the single slot and every added listener hear a committed move", () => {
    const heard: string[] = [];
    transitions.setTodoStatusChangeListener((event) => { heard.push(`slot:${event.toStatus}`); });
    cleanups.push(transitions.addTodoStatusChangeListener((event) => { heard.push(`first:${event.toStatus}`); }));
    cleanups.push(transitions.addTodoStatusChangeListener((event) => { heard.push(`second:${event.item.id}`); }));
    const item = executing();
    transitions.transition(item.id, "in_review", "board-walk");
    expect(heard).toEqual(["slot:in_review", "first:in_review", `second:${item.id}`]);
  });

  it("replacing the slot leaves added listeners in place, and removing one stops only it", () => {
    const heard: string[] = [];
    const remove = transitions.addTodoStatusChangeListener(() => { heard.push("added"); });
    cleanups.push(remove);
    transitions.setTodoStatusChangeListener(() => { heard.push("slot-1"); });
    transitions.setTodoStatusChangeListener(() => { heard.push("slot-2"); });
    transitions.transition(executing().id, "in_review", "board-walk");
    expect(heard).toEqual(["slot-2", "added"]);
    remove();
    heard.length = 0;
    transitions.transition(executing().id, "in_review", "board-walk");
    expect(heard).toEqual(["slot-2"]);
  });

  it("a listener that throws or rejects neither stops the others nor undoes the move", async () => {
    const heard: string[] = [];
    cleanups.push(transitions.addTodoStatusChangeListener(() => { throw new Error("boom"); }));
    cleanups.push(transitions.addTodoStatusChangeListener(async () => { throw new Error("later boom"); }));
    cleanups.push(transitions.addTodoStatusChangeListener(() => { heard.push("survivor"); }));
    const item = executing();
    expect(() => transitions.transition(item.id, "in_review", "board-walk")).not.toThrow();
    await Promise.resolve();
    expect(heard).toEqual(["survivor"]);
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");
  });
});
