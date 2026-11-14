import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// The note a turn leads with when a session was stopped under background tasks is part of the prompt the
// engine's transcript holds, and never part of the message the session stored.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-external-turns-note-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Reg = typeof import("../../sessions/registry.js");
type Ext = typeof import("../external-turns.js");
type Left = typeof import("../../sessions/left-background-tasks.js");
let reg: Reg;
let ext: Ext;
let left: Left;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  ext = await import("../external-turns.js");
  left = await import("../../sessions/left-background-tasks.js");
  (await import("../../shared/db.js")).initDb();
});

const TASKS = [
  { id: "bk2tests1", kind: "process" as const, command: "npm test\nnpm run lint", description: "Run the tests", agentType: null },
  { id: "bk2watch2", kind: "monitor" as const, command: "tail -f build.log", description: null, agentType: null },
];

function notePrompt(prompt: string, tasks = TASKS): string {
  const entries = tasks.map((task) => ({ ...task, reason: "stopped" as const, at: "2026-11-07T07:00:00.000Z" }));
  return left.withLeftBackgroundTasksNote({ transportMeta: { leftBackgroundTasks: entries } as never }, prompt).promptToRun;
}

const userEntry = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

describe("a transcript user entry that leads with the left-behind tasks note", () => {
  it("reads as the message that follows the note, for one task and for several", () => {
    expect(ext.transcriptEntryText(userEntry(notePrompt("please look at the Todo", TASKS.slice(0, 1)))))
      .toEqual({ role: "user", content: "please look at the Todo" });
    expect(ext.transcriptEntryText(userEntry(notePrompt("line one\n\nline two"))))
      .toEqual({ role: "user", content: "line one\n\nline two" });
  });

  it("reads as nothing when the note is all there was", () => {
    expect(ext.transcriptEntryText(userEntry(notePrompt("")))).toBeNull();
  });

  it("strips it together with the board reminder, and leaves a note quoted mid-message alone", async () => {
    const { withBoardReminder, DEFAULT_BOARD_REMINDER } = await import("../../sessions/turn/board-reminder.js");
    expect(ext.transcriptEntryText(userEntry(withBoardReminder(notePrompt("go"), DEFAULT_BOARD_REMINDER))))
      .toEqual({ role: "user", content: "go" });
    const quoted = `I saw: ${notePrompt("go")}`;
    expect(ext.transcriptEntryText(userEntry(quoted))).toEqual({ role: "user", content: quoted });
  });

  it("is reconciled with the stored row instead of being written in as a second user message", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:note-1", prompt: "test" });
    reg.insertMessage(session.id, "user", "please look at the Todo");
    reg.insertMessage(session.id, "assistant", "On it.");
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();
    const file = path.join(tmp, "transcript-note.jsonl");
    fs.writeFileSync(file, [
      { type: "user", text: notePrompt("please look at the Todo"), ts: future(1_000) },
      { type: "assistant", text: "On it. Done.", ts: future(2_000) },
    ].map((entry) => JSON.stringify({
      type: entry.type, timestamp: entry.ts, isSidechain: false, message: { role: entry.type, content: [{ type: "text", text: entry.text }] },
    })).join("\n") + "\n");

    const synced = ext.syncExternalTurn(session.id, () => {}, { hook_event_name: "Stop", transcript_path: file, last_assistant_message: "On it. Done." });

    expect(synced).toBe(0);
    expect(reg.getMessages(session.id).map((m) => [m.role, m.content])).toEqual([
      ["user", "please look at the Todo"],
      ["assistant", "On it. Done."],
    ]);
  });
});
