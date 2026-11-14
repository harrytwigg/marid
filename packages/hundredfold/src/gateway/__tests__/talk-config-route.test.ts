import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_KEY, baseConfig, call } from "./helpers/talk-route-harness.js";
import type { HundredfoldConfig } from "../../shared/types.js";

/**
 * `GET /api/talk/config` is what the orb asks before it asks for a session, so
 * the two things it must never do are mint and leak. Nothing here stubs the
 * provider factory: `configured` is asserted against the real one.
 */

let config: HundredfoldConfig;

function realtimeOf(config: HundredfoldConfig) {
  return (config as { realtime?: Record<string, unknown> }).realtime!;
}

/** The payload's voice list, typed — `body` is deliberately loose. */
function voicesOf(res: { body: Record<string, unknown> }): string[] {
  const voices = res.body.voices;
  return Array.isArray(voices) ? voices as string[] : [];
}

async function probe() {
  const res = await call(config, "GET", "/api/talk/config");
  expect(res.status).toBe(200);
  return res;
}

beforeEach(() => {
  config = baseConfig();
  delete process.env.TALK_TEST_REALTIME_KEY;
});

describe("GET /api/talk/config", () => {
  it("reports voice unconfigured, with no provider, when realtime is absent", async () => {
    delete (config as { realtime?: unknown }).realtime;

    const res = await probe();

    expect(res.body.configured).toBe(false);
    expect(res.body.provider).toBeNull();
  });

  it("reports voice configured when the provider is known and its key resolves", async () => {
    const res = await probe();

    expect(res.body.configured).toBe(true);
    expect(res.body.provider).toBe("openai");
  });

  it("offers the provider names the gateway implements", async () => {
    const res = await probe();

    expect(res.body.providers).toEqual(["openai"]);
  });

  it("carries the configured provider's own voices, so Settings can offer a picker", async () => {
    const res = await probe();

    const voices = voicesOf(res);
    expect(voices.length).toBeGreaterThan(1);
    // A real one, named: the picker is only useful if these are the strings the
    // provider actually accepts on a session.
    expect(voices).toContain("marin");
    // Sorted and unique, so the picker never shows a duplicate or a jumble.
    expect(voices).toEqual([...new Set(voices)].sort());
  });

  it("offers no voices for a provider it does not implement", async () => {
    realtimeOf(config).provider = "gemini";

    const res = await probe();

    expect(voicesOf(res)).toEqual([]);
  });

  it("reports unconfigured for a provider name the gateway does not implement", async () => {
    realtimeOf(config).provider = "gemini";

    const res = await probe();

    expect(res.body.configured).toBe(false);
    // Named anyway: the operator has to see what is set to understand why.
    expect(res.body.provider).toBe("gemini");
  });

  it("reports unconfigured when the provider is named but has no key", async () => {
    delete realtimeOf(config).apiKey;

    const res = await probe();

    expect(res.body.configured).toBe(false);
  });

  it("resolves an ${ENV_VAR} key, and reports unconfigured while the variable is unset", async () => {
    realtimeOf(config).apiKey = "${TALK_TEST_REALTIME_KEY}";

    const unset = await probe();
    expect(unset.body.configured).toBe(false);

    process.env.TALK_TEST_REALTIME_KEY = ACCOUNT_KEY;
    const set = await probe();
    expect(set.body.configured).toBe(true);
  });

  it("never puts the key in the response, literal or referenced", async () => {
    const literal = await probe();
    expect(literal.text).not.toContain(ACCOUNT_KEY);
    // The voice list is provider knowledge and travels; the account key is not
    // and never does, no matter what else the payload grows.
    expect(voicesOf(literal).length).toBeGreaterThan(0);

    realtimeOf(config).apiKey = "${TALK_TEST_REALTIME_KEY}";
    process.env.TALK_TEST_REALTIME_KEY = ACCOUNT_KEY;
    const referenced = await probe();
    expect(referenced.text).not.toContain(ACCOUNT_KEY);
    expect(referenced.text).not.toContain("TALK_TEST_REALTIME_KEY");
  });

  // The gateway's own auth layer still stands in front of this, as it does in
  // front of every route. What is asserted here is only that the talk router
  // does not additionally treat the probe as a write.
  it("is a read, so the router's write-only credential check does not apply", async () => {
    const res = await call(config, "GET", "/api/talk/config", undefined, {});

    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
  });
});
