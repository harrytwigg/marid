import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_KEY,
  OPENAI_CLIENT_SECRETS_URL,
  baseConfig,
  call,
  stubMintingFetch,
} from "./helpers/talk-route-harness.js";
import type { JinnConfig } from "../../shared/types.js";
import { TALK_BRIEF_BUDGET_CHARS } from "../../talk/session/brief.js";
import { TALK_CONTEXT_BUDGET_TOKENS, estimateTokens } from "../../talk/session/context.js";
import { buildTalkControlManifest } from "../../talk/control/manifest.js";

const workItems = await import("../../work-items/store.js");
const comments = await import("../../work-items/comments.js");

let config: JinnConfig;
let minting: ReturnType<typeof stubMintingFetch>;

beforeEach(() => {
  config = baseConfig();
  minting = stubMintingFetch();
});

async function open() {
  const res = await call(config, "POST", "/api/talk/sessions");
  expect(res.status).toBe(201);
  return res.body;
}

describe("opening a talk session", () => {
  it("returns an id and a credential that expires in the future", async () => {
    const body = await open();
    expect(typeof body.id).toBe("string");
    expect(body.state).toBe("live");
    expect(body.token).toBe("ephemeral-secret-1");
    expect(body.expiresAt as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(minting.calls[0]!.url).toBe(OPENAI_CLIENT_SECRETS_URL);
  });

  it("sends the account key to the provider and never puts it in a response", async () => {
    const opened = await call(config, "POST", "/api/talk/sessions");
    const status = await call(config, "GET", `/api/talk/sessions/${opened.body.id as string}`);
    const reissued = await call(config, "POST", `/api/talk/sessions/${opened.body.id as string}/token`);

    // The key really did travel: the provider authenticated with it.
    expect(minting.calls[0]!.authorization).toBe(`Bearer ${ACCOUNT_KEY}`);
    for (const res of [opened, status, reissued]) {
      expect(res.text).not.toContain(ACCOUNT_KEY);
    }
  });

  it("answers 503 attributing the refusal to configuration when realtime is unconfigured", async () => {
    delete (config as { realtime?: unknown }).realtime;
    const res = await call(config, "POST", "/api/talk/sessions");
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("unconfigured");
    // The factory's words are kept for the log, not for the operator: the
    // client answers this reason with a setup card of its own.
    expect(String(res.body.detail)).toMatch(/realtime\.provider/);
    expect(String(res.body.error)).not.toMatch(/realtime\.provider/);
    expect(res.text).not.toContain(ACCOUNT_KEY);
  });

  it("answers 401 for an unauthenticated write", async () => {
    const res = await call(config, "POST", "/api/talk/sessions", undefined, {});
    expect(res.status).toBe(401);
  });

  it("returns the same authoritative manifest used to mint provider tools", async () => {
    const body = await open();
    const manifest = buildTalkControlManifest();
    expect(body.manifest).toEqual(manifest);
    expect((body.tools as Array<{ name: string }>).map((tool) => tool.name))
      .toEqual(manifest.operations.map((operation) => operation.name));
  });
});

describe("universal Talk control", () => {
  it("propagates one stable operation key into a conditional Todo edit", async () => {
    const todo = workItems.createWorkItem({ title: "Before voice edit" });
    const session = await open();
    const request = {
      providerCallId: "provider-call-edit-1",
      tool: "talk_edit_todo",
      arguments: JSON.stringify({ id: todo.id, expectedVersion: todo.version, title: "After voice edit" }),
    };
    const path = `/api/talk/sessions/${session.id as string}/control`;
    expect((await call(config, "POST", path, request)).body).toMatchObject({ ok: true, verified: true, replayed: false });
    expect((await call(config, "POST", path, request)).body).toMatchObject({ ok: true, verified: true, replayed: true });
    const updated = workItems.getWorkItem(todo.id)!;
    expect(updated.title).toBe("After voice edit");
    expect(updated.version).toBe(todo.version + 1);
  });

  it("executes, verifies, and deduplicates a gateway Todo comment", async () => {
    const todo = workItems.createWorkItem({ title: "Verify the operator control route" });
    const session = await open();
    const body = {
      providerCallId: "provider-call-comment-1",
      providerItemId: "provider-item-1",
      tool: "talk_comment_todo",
      arguments: JSON.stringify({ id: todo.id, body: "One verified comment" }),
    };

    const first = await call(config, "POST", `/api/talk/sessions/${session.id as string}/control`, body);
    const replay = await call(config, "POST", `/api/talk/sessions/${session.id as string}/control`, body);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, verified: true, replayed: false, operation: "talk_comment_todo" });
    expect(replay.body).toMatchObject({ ok: true, verified: true, replayed: true, receiptId: first.body.receiptId });
    expect(comments.listComments(todo.id).comments.map((comment) => comment.body))
      .toEqual(["One verified comment"]);
    const status = await call(config, "GET", `/api/talk/sessions/${session.id as string}`);
    expect(status.body.actions).toMatchObject([{ tool: "talk_comment_todo", subject: todo.id }]);
  });

  it("fails a changed replay and non-operator control call closed", async () => {
    const todo = workItems.createWorkItem({ title: "Refuse authority confusion" });
    const session = await open();
    const path = `/api/talk/sessions/${session.id as string}/control`;
    const original = {
      providerCallId: "provider-call-conflict-1",
      tool: "read_todo",
      arguments: JSON.stringify({ id: todo.id }),
    };
    expect((await call(config, "POST", path, original)).body).toMatchObject({ ok: true });
    expect((await call(config, "POST", path, { ...original, arguments: JSON.stringify({ id: "PLA-999" }) })).body)
      .toMatchObject({ ok: false, code: "provider-call-conflict" });
    expect((await call(config, "POST", path, original, {})).status).toBe(401);
  });
});

describe("a session is not bound to a connection", () => {
  it("answers three successive reads with the same id, state, and history", async () => {
    const opened = await open();
    const id = opened.id as string;
    await call(config, "POST", `/api/talk/sessions/${id}/turn`, {
      usage: {
        inputAudioTokens: 10,
        outputAudioTokens: 10,
        inputTextTokens: 0,
        outputTextTokens: 0,
        cachedInputAudioTokens: 0,
        cachedInputTextTokens: 0,
      },
      transcript: "what is on the board today",
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await call(config, "GET", `/api/talk/sessions/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.state).toBe("live");
      expect(res.body.turns).toHaveLength(1);
    }
  });

  it("answers 404 for a session that was closed", async () => {
    const id = (await open()).id as string;
    expect((await call(config, "DELETE", `/api/talk/sessions/${id}`)).status).toBe(200);
    // Close is idempotent; the read afterwards is not a 500.
    expect((await call(config, "DELETE", `/api/talk/sessions/${id}`)).status).toBe(200);
    expect((await call(config, "GET", `/api/talk/sessions/${id}`)).status).toBe(404);
  });
});

describe("park and resume", () => {
  it("flips state and re-mints a credential that outlives the first", async () => {
    const opened = await open();
    const id = opened.id as string;

    const parked = await call(config, "POST", `/api/talk/sessions/${id}/park`);
    expect(parked.status).toBe(200);
    expect(parked.body.state).toBe("parked");
    // Parking asks the provider for nothing: the point is that it costs nothing.
    expect(minting.calls).toHaveLength(1);

    const resumed = await call(config, "POST", `/api/talk/sessions/${id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.state).toBe("live");
    expect(resumed.body.expiresAt as number).toBeGreaterThan(opened.expiresAt as number);
  });

  it("refuses a re-mint that does not outlive the credential it replaces", async () => {
    // A provider pinned to one absolute expiry: no amount of waiting makes the
    // successor longer-lived, and returning it would claim a freshness it does
    // not have.
    minting = stubMintingFetch(2_000_000_000);
    const opened = await open();
    const id = opened.id as string;
    await call(config, "POST", `/api/talk/sessions/${id}/park`);

    const resumed = await call(config, "POST", `/api/talk/sessions/${id}/resume`);
    expect(resumed.status).toBe(502);
    expect(String(resumed.body.error)).toMatch(/no later than the one it replaced/);
    expect(minting.calls.length).toBeGreaterThan(2); // it did try again after waiting
  });

  it("parks idempotently but rejects resume on a live session with 409", async () => {
    const id = (await open()).id as string;

    const resumeWhileLive = await call(config, "POST", `/api/talk/sessions/${id}/resume`);
    expect(resumeWhileLive.status).toBe(409);

    await call(config, "POST", `/api/talk/sessions/${id}/park`);
    const parkAgain = await call(config, "POST", `/api/talk/sessions/${id}/park`);
    expect(parkAgain.status).toBe(200);
    expect(parkAgain.body.state).toBe("parked");
  });

  it("answers 404 rather than 500 for an unknown id", async () => {
    const res = await call(config, "POST", "/api/talk/sessions/not-a-session/park");
    expect(res.status).toBe(404);
  });
});

describe("the minted tool catalog", () => {
  it("mints the opening credential with the authoritative universal set", async () => {
    const body = await open();
    const expected = buildTalkControlManifest().operations.map((operation) => operation.name);
    expect((body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(expected);
    const sent = minting.calls[0]!.body as { session: { tools: Array<{ name: string }> } };
    expect(sent.session.tools.map((tool) => tool.name)).toEqual(expected);
  });

  it("re-mints against the same universal manifest", async () => {
    const id = (await open()).id as string;
    await call(config, "POST", `/api/talk/sessions/${id}/token`);

    const sent = minting.calls.at(-1)!.body as { session: { tools: Array<{ name: string }> } };
    expect(sent.session.tools.map((tool) => tool.name))
      .toEqual(buildTalkControlManifest().operations.map((operation) => operation.name));
  });
});

describe("the standing brief", () => {
  it("hands the browser the brief and reports what it costs", async () => {
    const body = await open();

    expect(String(body.brief)).toContain("Todo");
    expect(body.briefChars).toBe(String(body.brief).length);
    expect(body.briefChars as number).toBeGreaterThan(0);
    expect(body.briefChars as number).toBeLessThanOrEqual(TALK_BRIEF_BUDGET_CHARS);
    expect(body.briefTokens).toBe(estimateTokens(String(body.brief)));
  });

  it("keeps the brief out of the turn budget it does not spend", async () => {
    const id = (await open()).id as string;

    const before = await call(config, "GET", `/api/talk/sessions/${id}`);
    expect(before.body.contextTokens).toBe(0);
    expect(before.body.contextBudgetTokens).toBe(TALK_CONTEXT_BUDGET_TOKENS);
    expect(before.body.briefTokens as number).toBeGreaterThan(0);

    await call(config, "POST", `/api/talk/sessions/${id}/turn`, {
      usage: {
        inputAudioTokens: 0,
        outputAudioTokens: 0,
        inputTextTokens: 0,
        outputTextTokens: 0,
        cachedInputAudioTokens: 0,
        cachedInputTextTokens: 0,
      },
      transcript: "who works here",
    });

    // The turn transcript is the only thing the budget meters: the brief rides
    // `instructions`, which is replaced rather than accumulated.
    const after = await call(config, "GET", `/api/talk/sessions/${id}`);
    expect(after.body.contextTokens).toBe(estimateTokens("who works here"));
    expect(after.body.contextBudgetTokens).toBe(TALK_CONTEXT_BUDGET_TOKENS);
    expect(after.body.briefChars).toBe(before.body.briefChars);
  });
});
