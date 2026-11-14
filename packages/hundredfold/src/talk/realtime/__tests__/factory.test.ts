import { afterEach, describe, expect, it } from "vitest";
import { REALTIME_PROVIDERS, UnknownRealtimeProviderError, createRealtimeProvider } from "../index.js";

const ENV_VAR = "HUNDREDFOLD_TEST_REALTIME_KEY";

afterEach(() => {
  delete process.env[ENV_VAR];
});

describe("createRealtimeProvider", () => {
  it("builds the OpenAI adapter for provider: openai", () => {
    const provider = createRealtimeProvider({ provider: "openai", apiKey: "sk-test" });
    expect(provider.name).toBe("openai");
  });

  it("throws a named error for a provider it does not implement", () => {
    expect(() => createRealtimeProvider({ provider: "gemini", apiKey: "sk-test" })).toThrow(UnknownRealtimeProviderError);
    try {
      createRealtimeProvider({ provider: "gemini", apiKey: "sk-test" });
      expect.unreachable("createRealtimeProvider accepted an unimplemented provider");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownRealtimeProviderError);
      expect((error as UnknownRealtimeProviderError).provider).toBe("gemini");
      expect((error as Error).message).toContain(REALTIME_PROVIDERS.join(", "));
    }
  });

  it("throws the same named error when the block names no provider at all", () => {
    expect(() => createRealtimeProvider({ apiKey: "sk-test" })).toThrow(UnknownRealtimeProviderError);
    expect(() => createRealtimeProvider({ apiKey: "sk-test" })).toThrow(/realtime.provider is not set/);
  });

  it("resolves an ${ENV_VAR} apiKey from the environment", () => {
    process.env[ENV_VAR] = "sk-from-env";
    expect(() => createRealtimeProvider({ provider: "openai", apiKey: `\${${ENV_VAR}}` })).not.toThrow();
  });

  it("fails loudly when the referenced environment variable is unset", () => {
    expect(() => createRealtimeProvider({ provider: "openai", apiKey: `\${${ENV_VAR}}` })).toThrow(/requires an API key/);
  });
});
