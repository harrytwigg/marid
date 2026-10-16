import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { as, call, sessionOf, startScopedHarness } from "./department-scope-harness.js";
import type { SubagentTranscriptResponse } from "../../shared/subagent-transcript.js";

/**
 * GET /api/sessions/:id/subagents/:agentId/transcript against the real API and registry, with a
 * Claude config dir of its own: the transcript read from beside the parent's, the 200 that says
 * "not available", and the same 404 a session outside the caller's department gets.
 */

let registry: Awaited<ReturnType<typeof startScopedHarness>>["registry"];
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-route-claude-"));
const agentId = "a0123456789abcdef";
const unknownSession = "00000000-0000-4000-8000-000000000000";

const read = async (sessionId: string, id = agentId, caller = call) =>
  caller("GET", `/api/sessions/${sessionId}/subagents/${id}/transcript`) as Promise<{ status: number; body: SubagentTranscriptResponse & { error?: string } }>;

/** A session with a Claude conversation whose transcript sits under the config dir; `lines` is the sub-agent's file. */
async function sessionWithSubagent(employee: string, lines?: string[]) {
  const session = await sessionOf(employee);
  const conversation = `conv-${session.id}`;
  registry.updateSession(session.id, { engineSessionId: conversation });
  const project = path.join(configDir, "projects", "route-project");
  fs.mkdirSync(path.join(project, conversation, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(project, `${conversation}.jsonl`), "");
  if (lines) fs.writeFileSync(path.join(project, conversation, "subagents", `agent-${agentId}.jsonl`), `${lines.join("\n")}\n`);
  return { session, project, conversation };
}

const ask = JSON.stringify({ type: "user", message: { content: "Look at the logs." } });
const said = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Found nothing odd." }] } });

beforeAll(async () => {
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  ({ registry } = await startScopedHarness());
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("GET /api/sessions/:id/subagents/:agentId/transcript", () => {
  it("answers 404 for an unknown session", async () => {
    expect((await read(unknownSession)).status).toBe(404);
  });

  it("reads the sub-agent's conversation from beside the parent's transcript", async () => {
    const { session } = await sessionWithSubagent("eng-dev", [ask, said]);
    const { status, body } = await read(session.id);
    expect(status).toBe(200);
    expect(body).toMatchObject({ sessionId: session.id, agentId, available: true, truncated: false });
    expect(body.available && body.entries).toEqual([
      { kind: "prompt", text: "Look at the logs.", at: null },
      { kind: "text", text: "Found nothing odd.", at: null },
    ]);
  });

  it("follows the file as the sub-agent writes to it", async () => {
    const { session, project, conversation } = await sessionWithSubagent("eng-dev", [ask]);
    const first = (await read(session.id)).body;
    expect(first.available && first.entries.map((entry) => entry.kind)).toEqual(["prompt"]);
    fs.appendFileSync(path.join(project, conversation, "subagents", `agent-${agentId}.jsonl`), `${said}\n`);
    const body = (await read(session.id)).body;
    expect(body.available && body.entries.map((entry) => entry.kind)).toEqual(["prompt", "text"]);
  });

  it("says the transcript is not available when the sub-agent's file is missing", async () => {
    const { session } = await sessionWithSubagent("eng-dev");
    const { status, body } = await read(session.id);
    expect({ status, body }).toEqual({ status: 200, body: { sessionId: session.id, agentId, available: false, reason: "not-found" } });
  });

  it("says so when the file cannot be read", async () => {
    const { session, project, conversation } = await sessionWithSubagent("eng-dev");
    // A directory where the file should be: present, and not readable as one.
    fs.mkdirSync(path.join(project, conversation, "subagents", `agent-${agentId}.jsonl`));
    expect((await read(session.id)).body).toMatchObject({ available: false, reason: "unreadable" });
  });

  it("says so for a session with no Claude conversation", async () => {
    const session = await sessionOf("eng-dev");
    expect((await read(session.id)).body).toMatchObject({ available: false, reason: "no-conversation" });
  });

  it("never follows an agent id out of the subagents folder", async () => {
    const { session, project, conversation } = await sessionWithSubagent("eng-dev", [ask]);
    // Where an unchecked id would land: a file the agent id's own `..` segments would reach.
    fs.writeFileSync(path.join(project, conversation, "agent-x.jsonl"), `${said}\n`);
    for (const id of ["..%2Fagent-x", "..", "a%2Fb", "x%2F..%2F..%2Fagent-x"]) {
      const { status, body } = await read(session.id, id);
      expect(status === 404 || (status === 200 && !body.available)).toBe(true);
    }
  });

  it("reads only a file name made of letters, digits, - and _", async () => {
    // `a.b` is one path segment the router lets through, and `agent-a.b.jsonl` a file it would find.
    const { session, project, conversation } = await sessionWithSubagent("eng-dev", [ask]);
    fs.writeFileSync(path.join(project, conversation, "subagents", "agent-a.b.jsonl"), `${said}\n`);
    const { status, body } = await read(session.id, "a.b");
    expect({ status, available: body.available }).toEqual({ status: 200, available: false });
  });
});

describe("a scoped caller", () => {
  it("cannot read the sub-agent transcript of a session outside its department, which answers as an unknown id does", async () => {
    const self = await sessionOf("side-dev");
    const { session: outside } = await sessionWithSubagent("eng-dev", [ask, said]);

    const hidden = await read(outside.id, agentId, (method, url) => as(self.id)(method, url));
    const unknown = await read(unknownSession, agentId, (method, url) => as(self.id)(method, url));

    expect({ status: hidden.status, body: hidden.body }).toEqual({ status: 404, body: unknown.body });
    expect(JSON.stringify(hidden.body)).not.toContain("Look at the logs");
  });

  it("reads the sub-agent transcript of its own department's session", async () => {
    const { session } = await sessionWithSubagent("side-dev", [ask, said]);
    const { status, body } = await read(session.id, agentId, (method, url) => as(session.id)(method, url));
    expect(status).toBe(200);
    expect(body.available && body.entries).toHaveLength(2);
  });
});
