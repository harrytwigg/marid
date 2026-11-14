import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the behaviour of GET/POST /api/tts across the move out of api.ts and into
 * the talk router. Kokoro itself is stubbed because its readiness depends on
 * weights and a venv being present on the machine, which is not something a
 * behaviour test should depend on. `validateTtsText` stays real: it is the
 * actual validator these routes are contracted to run.
 */
const kokoro = vi.hoisted(() => ({ available: false }));

vi.mock("../../talk/tts-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../talk/tts-stream.js")>();
  return {
    ...actual,
    ttsStatus: () => ({ available: kokoro.available, voice: "af_heart" }),
    streamTtsSentences: async (
      _text: string,
      _opts: unknown,
      onWav: (wav: Buffer) => void,
    ) => {
      onWav(Buffer.from("WAVDATA"));
      onWav(Buffer.from("XYZ"));
    },
  };
});

const { baseConfig, call } = await import("./helpers/talk-route-harness.js");

let config: ReturnType<typeof baseConfig>;

beforeEach(() => {
  config = baseConfig();
  kokoro.available = false;
});

describe("GET /api/tts", () => {
  it("reports engine readiness so the client can pick without a failed POST", async () => {
    const res = await call(config, "GET", "/api/tts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, voice: "af_heart" });

    kokoro.available = true;
    expect((await call(config, "GET", "/api/tts")).body).toEqual({ available: true, voice: "af_heart" });
  });
});

describe("POST /api/tts", () => {
  it("503s with available:false when Kokoro cannot run", async () => {
    const res = await call(config, "POST", "/api/tts", { text: "hello" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ available: false });
  });

  it("400s on text that is not a usable string", async () => {
    kokoro.available = true;
    expect((await call(config, "POST", "/api/tts", { text: 42 })).status).toBe(400);
    const empty = await call(config, "POST", "/api/tts", { text: "   " });
    expect(empty.status).toBe(400);
    expect(String(empty.body.error)).toMatch(/non-empty/);
  });

  it("streams one 4-byte big-endian length-prefixed WAV frame per sentence", async () => {
    kokoro.available = true;
    const res = await call(config, "POST", "/api/tts", { text: "One. Two." });

    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/octet-stream");

    const raw = res.raw;
    expect(raw.readUInt32BE(0)).toBe(7);
    expect(raw.subarray(4, 11).toString()).toBe("WAVDATA");
    expect(raw.readUInt32BE(11)).toBe(3);
    expect(raw.subarray(15, 18).toString()).toBe("XYZ");
    expect(raw).toHaveLength(18);
  });
});
