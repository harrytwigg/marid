import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A Todo with a start date still ahead is held by the board walk: its board
 * line and full view name the date, and a start is refused in code with the
 * date in the tick log, whatever the model decided. Once the date has passed
 * the same Todo starts like any other.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-walk-start-date-"));
process.env.JINN_HOME = home;

const m = {} as {
  apply: typeof import("../apply.js");
  board: typeof import("../board.js");
  render: typeof import("../board-render.js");
  store: typeof import("../../work-items/store.js");
};

const NOW = Date.parse("2026-10-06T12:00:00Z");
const settings = { actions: { dispatch: true, comment: false, release: true, park: true, flagStuck: true } } as never;

beforeAll(async () => {
  m.apply = await import("../apply.js");
  m.board = await import("../board.js");
  m.render = await import("../board-render.js");
  m.store = await import("../../work-items/store.js");
});

function start(startAt: string) {
  const item = m.store.createWorkItem({ title: `starts ${startAt}`, source: "human", startAt });
  const dispatch = vi.fn(() => ({ ok: true, status: 201, body: { workItemId: item.id, sessionId: "s-1", status: "running", reused: false } }) as never);
  const entry = m.apply.startTodo({ settings, state: { stuckFlags: {} }, dispatch, now: () => NOW, resolveLink: vi.fn() }, { id: item.id, reason: "spare capacity" } as never);
  return { item, entry, dispatch };
}

describe("the start date gate in the board walk", () => {
  it("refuses to start a Todo before its start date, naming the date", () => {
    const { entry, dispatch } = start("2026-10-07T09:00:00.000Z");
    expect(entry).toMatchObject({ kind: "refused", outcome: "it is held until its start date, 2026-10-07T09:00:00.000Z" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("starts it once the start date has passed", () => {
    const { entry, dispatch } = start("2026-10-06T11:59:00.000Z");
    expect(entry).toMatchObject({ kind: "dispatch", outcome: "started the Todo Dispatcher" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("shows the hold on the board line only while the date is ahead, and the date in the full view", async () => {
    const ahead = m.store.createWorkItem({ title: "later", source: "human", startAt: "2026-10-08T00:00:00.000Z", dueAt: "2026-10-09T00:00:00.000Z" });
    const passed = m.store.createWorkItem({ title: "now", source: "human", startAt: "2026-10-01T00:00:00.000Z" });
    expect(m.render.boardLine(ahead, { flagged: false, now: NOW })).toContain("not before its start date 2026-10-08T00:00Z");
    expect(m.render.boardLine(passed, { flagged: false, now: NOW })).not.toContain("start date");

    const full = m.render.renderTodo(await m.board.digestTodo(ahead, { resolveLink: vi.fn(), now: NOW }));
    expect(full).toContain("starts 2026-10-08T00:00Z (holds it: not started before then) · due 2026-10-09T00:00Z");
    const passedFull = m.render.renderTodo(await m.board.digestTodo(passed, { resolveLink: vi.fn(), now: NOW }));
    expect(passedFull).toContain("starts 2026-10-01T00:00Z");
    expect(passedFull).not.toContain("holds it");
  });
});
