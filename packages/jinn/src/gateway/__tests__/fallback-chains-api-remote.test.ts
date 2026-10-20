import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { JinnConfig } from "../../shared/types.js";
import { baseConfig, call, home, loadApi, resetFallbackFixture, setConfig, unloadApi } from "./session-fallback-api-harness.js";

/**
 * GET /api/fallback-chains for an employee that runs on a remote host: its links
 * are judged on that host, as its turns' are. Muse Code goes remote, so its link
 * is offered there, and passed over with the host named when that host has no
 * `muse`; an engine that cannot go remote is still passed over as `remote`.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
/** What the host's facts say is installed there, by engine; unset is installed. */
let onHost: Record<string, boolean> = {};
const asked: string[] = [];
vi.mock("../../engines/remote-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../engines/remote-stage.js")>()),
  remoteEngineAvailable: (destination: string, engine: string) => {
    asked.push(`${destination}:${engine}`);
    return onHost[engine] ?? true;
  },
}));

beforeAll(loadApi);
afterAll(unloadApi);
beforeEach(() => {
  resetFallbackFixture();
  setConfig(remoteConfig());
  onHost = {};
  asked.length = 0;
  writeEmployee();
});

const WORKER_FILE = path.join(home, "org", "a-worker.yaml");
const CHAIN = [
  { engine: "musecode", model: "muse-wonder-1.0" },
  { engine: "codex" },
];

function remoteConfig(): JinnConfig {
  return {
    ...baseConfig,
    remote: { root: "/srv/agents", mount: "/mnt/jinn-home" },
    engines: { ...baseConfig.engines, musecode: { bin: "muse" }, opencode: { bin: "opencode", model: "opencode/big-pickle" } },
    models: { ...baseConfig.models, musecode: { default: "muse-spark-1.3", models: [{ id: "muse-spark-1.3" }, { id: "muse-wonder-1.0" }] } },
  } as unknown as JinnConfig;
}

function writeEmployee(): void {
  fs.writeFileSync(WORKER_FILE, yaml.dump({
    name: "a-worker", displayName: "A Worker", department: "platform", rank: "employee", engine: "claude", model: "opus",
    persona: "Remote fallback fixture", remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/agents/main", fallback: CHAIN,
  }));
}

const employeeChain = async () => {
  const got = await call("GET", "/api/fallback-chains?employee=a-worker");
  expect(got.status).toBe(200);
  return got.body.subjects.find((s: any) => s.kind === "employee" && s.id === "a-worker");
};
const skips = (links: Array<{ engine: string; skip?: string; skipDetail?: string }>) =>
  links.map((link) => [link.engine, link.skip ?? null, link.skipDetail ?? null]);

describe("GET /api/fallback-chains?employee=<remote employee>", () => {
  it("offers the Muse Code link on a host that has `muse`, and skips only what cannot go remote", async () => {
    const chain = await employeeChain();
    expect(skips(chain.effective).slice(0, 2)).toEqual([
      ["musecode", null, null],
      ["codex", "remote", null],
    ]);
    expect(asked).toContain("builder@build-box:musecode");
  });

  it("skips it on a host without `muse`, naming the host", async () => {
    onHost = { musecode: false };
    const chain = await employeeChain();
    expect(skips(chain.effective)[0]).toEqual(["musecode", "not-installed", "builder@build-box has no `muse` on its non-interactive PATH"]);
  });

  it("judges only the employee's chain on its host: the engine chains are the gateway's", async () => {
    onHost = { musecode: false };
    setConfig({ ...remoteConfig(), engines: { ...remoteConfig().engines, claude: { ...(remoteConfig().engines as any).claude, fallback: [{ engine: "musecode" }] } } } as JinnConfig);
    const got = await call("GET", "/api/fallback-chains?employee=a-worker");
    const engine = got.body.subjects.find((s: any) => s.kind === "engine" && s.id === "claude");
    expect(engine.effective.find((l: any) => l.engine === "musecode")).not.toHaveProperty("skip");
  });
});
