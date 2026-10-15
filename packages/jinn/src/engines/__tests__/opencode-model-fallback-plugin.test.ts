import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OpenCode 2 model-fallback host plugin (examples/opencode-plugins), driven
 * through a stand-in for the plugin context: its retry hook, model switches
 * and execution events. The real-binary check is opencode-v2-e2e.test.ts.
 */

const PLUGIN = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../examples/opencode-plugins/model-fallback.js")).href;

interface Model { providerID: string; id: string }
interface RetryInput { sessionID: string; model: Model; error: Record<string, unknown>; attempt: number; decision?: { retry: boolean; delay?: number } }

const RATE_LIMIT = { type: "provider.rate-limit", status: 429, message: "rate limited" };
const model = (key: string): Model => {
  const slash = key.indexOf("/");
  return { providerID: key.slice(0, slash), id: key.slice(slash + 1) };
};

let home: string;
beforeEach(() => {
  // The plugin also reads rate-limit-fallback.json from the home it runs in.
  home = fs.mkdtempSync(path.join(os.tmpdir(), "model-fallback-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** The plugin set up with `options`, and what it did. */
async function plugin(options: Record<string, unknown>) {
  const { default: definition } = await import(PLUGIN) as { default: { setup: (ctx: unknown) => Promise<unknown> } };
  let retry: ((input: RetryInput) => Promise<void>) | undefined;
  const switches: Array<{ sessionID: string; model: Model }> = [];
  const current = new Map<string, Model>();
  const events: Array<Record<string, unknown>> = [];
  let wake: (() => void) | undefined;
  const ctx = {
    location: { directory: home },
    options: { retryPolicy: { strategy: "immediate" }, ...options },
    session: {
      hook: async (name: string, fn: typeof retry) => { if (name === "retry") retry = fn; },
      switchModel: async (args: { sessionID: string; model: Model }) => { switches.push(args); current.set(args.sessionID, args.model); },
      get: async ({ sessionID }: { sessionID: string }) => ({ model: current.get(sessionID) }),
      synthetic: async () => {},
    },
    command: { transform: async () => {} },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (events.length) yield events.shift();
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
      }),
    },
  };
  await definition.setup(ctx);
  /** One rate-limited attempt of `sessionID` on `on`: the model it moved to, if any. */
  const rateLimited = async (sessionID: string, on: string) => {
    current.set(sessionID, model(on));
    const input: RetryInput = { sessionID, model: model(on), error: RATE_LIMIT, attempt: 2 };
    const before = switches.length;
    await retry!(input);
    const moved = switches.slice(before).at(-1)?.model;
    return { to: moved ? `${moved.providerID}/${moved.id}` : undefined, decision: input.decision };
  };
  const endExecution = async (sessionID: string) => {
    events.push({ type: "session.execution.succeeded", data: { sessionID } });
    wake?.();
    await new Promise((r) => setTimeout(r, 20));
  };
  return { rateLimited, endExecution, hooked: () => retry !== undefined };
}

describe("fallback chains per model", () => {
  const chains = {
    "opencode-go/fast": [{ providerID: "openrouter", modelID: "fast-backup" }, { providerID: "openrouter", modelID: "fast-backup-2" }],
    "opencode-go/smart": [{ providerID: "openrouter", modelID: "smart-backup" }],
    "*": [{ providerID: "openrouter", modelID: "any-backup" }],
  };

  it("sends each model to its own chain, and any other model to \"*\"", async () => {
    const p = await plugin({ fallbackModels: chains });
    expect((await p.rateLimited("ses_a", "opencode-go/fast")).to).toBe("openrouter/fast-backup");
    expect((await p.rateLimited("ses_b", "opencode-go/smart")).to).toBe("openrouter/smart-backup");
    expect((await p.rateLimited("ses_c", "opencode-go/other")).to).toBe("openrouter/any-backup");
  });

  it("lets the retry go ahead on the fallback", async () => {
    const p = await plugin({ fallbackModels: chains });
    expect((await p.rateLimited("ses_a", "opencode-go/fast")).decision).toEqual({ retry: true, delay: 0 });
  });

  it("stays on the original model's chain when a fallback is rate-limited too", async () => {
    const p = await plugin({ fallbackModels: chains });
    expect((await p.rateLimited("ses_a", "opencode-go/fast")).to).toBe("openrouter/fast-backup");
    // Not "*", although openrouter/fast-backup is not named itself.
    expect((await p.rateLimited("ses_a", "openrouter/fast-backup")).to).toBe("openrouter/fast-backup-2");
  });

  it("takes the chain afresh in the next execution, from the model it starts on", async () => {
    const p = await plugin({ fallbackModels: chains, cooldownMs: 0 });
    expect((await p.rateLimited("ses_a", "opencode-go/fast")).to).toBe("openrouter/fast-backup");
    await p.endExecution("ses_a");
    expect((await p.rateLimited("ses_a", "opencode-go/smart")).to).toBe("openrouter/smart-backup");
  });

  it("leaves a model with no chain of its own and no \"*\" to OpenCode's own retries", async () => {
    const p = await plugin({ fallbackModels: { "opencode-go/fast": chains["opencode-go/fast"] } });
    const { to, decision } = await p.rateLimited("ses_c", "opencode-go/other");
    expect(to).toBeUndefined();
    expect(decision).toBeUndefined();
  });

  it("keeps a model named with an empty chain off fallback, instead of sending it down \"*\"", async () => {
    const p = await plugin({ fallbackModels: { "opencode-go/local-only": [], "*": chains["*"] } });
    const { to, decision } = await p.rateLimited("ses_a", "opencode-go/local-only");
    expect(to).toBeUndefined();
    expect(decision).toBeUndefined();
    expect((await p.rateLimited("ses_b", "opencode-go/other")).to).toBe("openrouter/any-backup");
  });

  it("drops entries that are not models, and is inactive with nowhere to fall back to", async () => {
    const p = await plugin({ fallbackModels: { "opencode-go/fast": [{ providerID: "openrouter" }], "*": "nope" } });
    expect(p.hooked()).toBe(false);
    expect((await plugin({ fallbackModels: { "opencode-go/fast": [] } })).hooked()).toBe(false);
    expect((await plugin({ fallbackModels: [] })).hooked()).toBe(false);
  });
});

describe("one list for every model (the opencode-rate-limit form)", () => {
  it("sends every model down the same list", async () => {
    const p = await plugin({ fallbackModels: [{ providerID: "openrouter", modelID: "backup" }] });
    expect((await p.rateLimited("ses_a", "opencode-go/fast")).to).toBe("openrouter/backup");
    expect((await p.rateLimited("ses_b", "opencode-go/smart")).to).toBe("openrouter/backup");
  });

  it("reads it from rate-limit-fallback.json", async () => {
    fs.mkdirSync(path.join(home, ".opencode"), { recursive: true });
    fs.writeFileSync(path.join(home, ".opencode", "rate-limit-fallback.json"), JSON.stringify({
      fallbackModels: { "opencode-go/fast": [{ providerID: "openrouter", modelID: "from-file" }] },
    }));
    const p = await plugin({});
    expect((await p.rateLimited("ses_a", "opencode-go/fast")).to).toBe("openrouter/from-file");
  });
});
