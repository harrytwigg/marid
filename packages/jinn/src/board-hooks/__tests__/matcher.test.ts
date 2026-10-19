import { describe, expect, it } from "vitest";
import { matchesHook } from "../matcher.js";
import { basePayload } from "./fixtures.js";
import type { BoardHookMatch } from "../../shared/board-hooks-config.js";

const payload = basePayload();
const fits = (match: BoardHookMatch | undefined, over = payload) => matchesHook({ match }, over, over.todo.labels);

describe("matchesHook", () => {
  it("matches everything when there is no matcher", () => {
    expect(fits(undefined)).toBe(true);
    expect(fits({})).toBe(true);
  });

  it("matches each field on its own", () => {
    expect(fits({ from: "executing" })).toBe(true);
    expect(fits({ from: "blocked" })).toBe(false);
    expect(fits({ to: "in_review" })).toBe(true);
    expect(fits({ to: "done" })).toBe(false);
    expect(fits({ department: "platform" })).toBe(true);
    expect(fits({ department: "ops" })).toBe(false);
    expect(fits({ label: "auto-merge" })).toBe(true);
    expect(fits({ label: "other" })).toBe(false);
    expect(fits({ assignee: "senior-developer" })).toBe(true);
    expect(fits({ assignee: "someone-else" })).toBe(false);
  });

  it("treats a list inside one field as any-of", () => {
    expect(fits({ from: ["blocked", "executing"] })).toBe(true);
    expect(fits({ from: ["blocked", "backlog"] })).toBe(false);
    expect(fits({ label: ["nope", "auto-merge"] })).toBe(true);
  });

  it("ANDs the fields together", () => {
    expect(fits({ from: "executing", to: "in_review", label: "auto-merge" })).toBe(true);
    expect(fits({ from: "executing", to: "done", label: "auto-merge" })).toBe(false);
    expect(fits({ from: "executing", to: "in_review", label: "other" })).toBe(false);
  });

  it("matches a label against any label the Todo carries", () => {
    const labelled = basePayload({ todo: { ...payload.todo, labels: ["a", "b"] } });
    expect(fits({ label: "b" }, labelled)).toBe(true);
    expect(fits({ label: "c" }, labelled)).toBe(false);
    expect(fits({ label: "a" }, basePayload({ todo: { ...payload.todo, labels: [] } }))).toBe(false);
  });

  it("matches the actor by kind or by employee slug", () => {
    const employee = basePayload({ actor: { raw: "session:s1", kind: "employee", employee: "merger", sessionId: "s1" } });
    expect(fits({ actor: "employee" }, employee)).toBe(true);
    expect(fits({ actor: "merger" }, employee)).toBe(true);
    expect(fits({ actor: "operator" }, employee)).toBe(false);
    expect(fits({ actor: ["operator", "system"] }, employee)).toBe(false);
    expect(fits({ actor: ["operator", "employee"] }, employee)).toBe(true);
    expect(fits({ actor: "operator" })).toBe(true);
    expect(fits({ actor: "system" }, basePayload({ actor: { raw: "reconciler", kind: "system" } }))).toBe(true);
  });

  it("matches assignee: operator against the operator assignee", () => {
    const owned = basePayload({ todo: { ...payload.todo, assignee: "@operator" } });
    expect(fits({ assignee: "operator" }, owned)).toBe(true);
    expect(fits({ assignee: "@operator" }, owned)).toBe(true);
    expect(fits({ assignee: "operator" })).toBe(false);
    expect(fits({ assignee: "operator" }, basePayload({ todo: { ...payload.todo, assignee: null } }))).toBe(false);
  });

  it("never matches a from/to constraint on an event with no status move", () => {
    const commented = basePayload({ event: "todo.commented", from: null, to: null });
    expect(fits({ to: "in_review" }, commented)).toBe(false);
    expect(fits({ from: "executing" }, commented)).toBe(false);
    expect(fits({ department: "platform" }, commented)).toBe(true);
  });
});
