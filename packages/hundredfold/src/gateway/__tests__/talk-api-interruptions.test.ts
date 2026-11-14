import { beforeEach, describe, expect, it } from "vitest";
import type { HundredfoldConfig } from "../../shared/types.js";
import { baseConfig, call, stubMintingFetch } from "./helpers/talk-route-harness.js";

const INTERRUPTION = {
  kind: "speech_interruption",
  vadType: "semantic_vad",
  cancelledBy: "provider",
  recovered: true,
  speechMs: 240,
} as const;

let config: HundredfoldConfig;

beforeEach(() => {
  config = baseConfig();
  stubMintingFetch();
});

async function open(): Promise<string> {
  const response = await call(config, "POST", "/api/talk/sessions");
  expect(response.status).toBe(201);
  return response.body.id as string;
}

function postInterruption(id: string, body: unknown) {
  return call(config, "POST", `/api/talk/sessions/${id}/interruptions`, body);
}

async function interruptions(id: string): Promise<Array<Record<string, unknown>>> {
  const response = await call(config, "GET", `/api/talk/sessions/${id}`);
  return response.body.interruptions as Array<Record<string, unknown>>;
}

describe("talk interruption telemetry", () => {
  it("persists one content-free interruption on its Talk session", async () => {
    const id = await open();
    const posted = await postInterruption(id, INTERRUPTION);

    expect(posted.status).toBe(201);
    expect(Object.keys(posted.body).sort()).toEqual([
      "at", "cancelledBy", "kind", "recovered", "speechMs", "vadType",
    ]);
    expect(posted.body).toMatchObject(INTERRUPTION);
    expect(await interruptions(id)).toEqual([posted.body]);
  });

  it("rejects transcript and audio fields without retaining their content", async () => {
    const id = await open();
    const privateCanary = "private-utterance-must-not-enter-interruption-telemetry";
    const posted = await postInterruption(id, {
      ...INTERRUPTION,
      transcript: privateCanary,
      audio: privateCanary,
      audioBytes: [1, 2, 3],
    });

    expect(posted.status).toBe(400);
    const stored = await interruptions(id);
    expect(stored).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain(privateCanary);
  });

  it("rejects malformed metadata and an unknown Talk session", async () => {
    const id = await open();
    const malformed = [
      { ...INTERRUPTION, kind: "transcript" },
      { ...INTERRUPTION, vadType: "client_vad" },
      { ...INTERRUPTION, cancelledBy: "client" },
      { ...INTERRUPTION, recovered: "yes" },
      { ...INTERRUPTION, speechMs: -1 },
    ];

    for (const body of malformed) {
      expect((await postInterruption(id, body)).status).toBe(400);
    }
    expect(await interruptions(id)).toEqual([]);
    expect((await postInterruption("not-a-session", INTERRUPTION)).status).toBe(404);
  });
});
