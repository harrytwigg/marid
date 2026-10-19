import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useTempHome } from "./db-fixtures.js";

const home = useTempHome("jinn-board-hooks-load-");

type Config = typeof import("../../shared/config.js");
let config: Config;
let hooksConfig: typeof import("../../shared/board-hooks-config.js");
let logger: typeof import("../../shared/logger.js").logger;

const goodHook = { name: "good", event: "todo.created", action: { command: { run: "true" } } };

beforeAll(async () => {
  config = await import("../../shared/config.js");
  hooksConfig = await import("../../shared/board-hooks-config.js");
  ({ logger } = await import("../../shared/logger.js"));
});

function writeConfig(hooks: unknown[]): void {
  const yaml = `engines:\n  claude:\n    bin: claude\nhooks:\n${hooks.map((hook) => `  - ${JSON.stringify(hook)}\n`).join("")}`;
  fs.writeFileSync(path.join(home, "config.yaml"), yaml);
}

describe("a bad hook in config.yaml", () => {
  it("does not stop the config loading, is logged once, and leaves the good hook runnable", async () => {
    writeConfig([goodHook, { name: "BAD", event: "nope", action: {} }]);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const loaded = config.loadConfig();
    config.loadConfig();
    expect(hooksConfig.runnableHooks(loaded).map((entry) => entry.hook.name)).toEqual(["good"]);
    const mentioning = warn.mock.calls.filter(([message]) => String(message).includes("config hooks: hooks[1] (BAD)"));
    expect(mentioning.length).toBeGreaterThan(0);
    const first = mentioning.length;
    config.loadConfig();
    expect(warn.mock.calls.filter(([message]) => String(message).includes("config hooks: hooks[1] (BAD)"))).toHaveLength(first);
    warn.mockRestore();
  });

  it("does not stop anything else that reads the config, such as creating a Todo", async () => {
    writeConfig([goodHook, { name: "BAD" }]);
    (await import("../../shared/db.js")).initDb();
    const store = await import("../../work-items/store.js");
    expect(() => store.createWorkItem({ title: "still works" })).not.toThrow();
  });
});
