import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-watch-callbacks-projects-"));
process.env.JINN_HOME = tmp;

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

let gatewayWatchCallbacks: typeof import("../watch-callbacks.js").gatewayWatchCallbacks;

beforeAll(async () => {
  ({ gatewayWatchCallbacks } = await import("../watch-callbacks.js"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("onProjectsChange", () => {
  it("re-reads projects/ and tells connected clients", () => {
    fs.mkdirSync(path.join(tmp, "projects"));
    fs.writeFileSync(path.join(tmp, "projects", "boat-club.yaml"), "id: prj_1a2b3c4d5e6f\nname: Boat Club\n");
    const emit = vi.fn();
    const callbacks = gatewayWatchCallbacks({ reloadConfig: vi.fn(), getConfig: () => ({}), reloadOrg: vi.fn(), emit });
    callbacks.onProjectsChange();
    expect(emit).toHaveBeenCalledWith("company:changed", { entity: "project", action: "reloaded", id: "*" });
  });
});
