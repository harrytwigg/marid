import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A turn that ran and was answered clears a limit its target still holds, when the
 * turn began after the limit was recorded. It is read off the row the turn started
 * with, so a session standing on a substitute clears the substitute and not its own
 * account, and a target changed mid-turn is not credited.
 */

const tmp = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/jinn-served-health-${process.pid}`);
vi.mock("../../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/paths.js")>()),
  JINN_HOME: tmp,
}));

import { noteTurnServed } from "../served-health.js";
import { readEngineHealth, recordEngineUnavailable } from "../../../shared/engine-health.js";
import { recordOpencodeFailure } from "../../../shared/engine-health-opencode.js";
import { makeSession } from "../../__tests__/helpers/session-fixture.js";
import type { EngineResult, Session } from "../../../shared/types.js";
import type { TurnRun } from "../types.js";

const STATE_PATH = path.join(tmp, "tmp", "engine-health.json");
const MIN = 60_000;
const FRIEND = "claude:friend01";
const answered: EngineResult = { sessionId: "t", result: "done", cost: 0.01 };

/** A limit a turn hit on `model`, recorded `minutes` ago. */
const spentMinutesAgo = (key: string, minutes: number, model = "opus") =>
  recordEngineUnavailable(key, "usage limit", (Date.now() + 4 * 24 * 60 * MIN) / 1000, new Date(Date.now() - minutes * MIN), { model });

/** A turn that started `minutes` ago on `session` (the row as the turn began). */
function runStartedMinutesAgo(minutes: number, session: Session = makeSession()): TurnRun {
  return { input: { employee: undefined, session }, plan: { engineName: session.engine, engineConfig: { model: "opus" } }, turnStartedAt: Date.now() - minutes * MIN } as unknown as TurnRun;
}

const served = (run: TurnRun, result: EngineResult = answered, silent = false) => noteTurnServed(run, "opus", { result, silent });

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});
afterEach(() => fs.rmSync(STATE_PATH, { recursive: true, force: true }));

describe("noteTurnServed", () => {
  it("clears the record of the account the turn ran on", () => {
    spentMinutesAgo("claude", 30);

    served(runStartedMinutesAgo(5));

    expect(readEngineHealth().claude).toMatchObject({ state: "ok", clearedAt: expect.any(String), reason: "a turn was served" });
  });

  it("does not clear on a turn that began before the limit was recorded", () => {
    spentMinutesAgo("claude", 5);

    served(runStartedMinutesAgo(30));

    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });

  it.each([
    ["a preempted, dead or limited turn", answered, true],
    ["a turn that ended in an error", { ...answered, error: "boom" }, false],
    ["a clean turn that produced nothing and cost nothing", { sessionId: "t", result: "" }, false],
  ])("says nothing for %s", (_name, result, silent) => {
    spentMinutesAgo("claude", 30);

    served(runStartedMinutesAgo(5), result as EngineResult, silent);

    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });

  it("clears the substitute account a session stands on, and leaves its own account's record alone", () => {
    spentMinutesAgo("claude", 30);
    spentMinutesAgo(FRIEND, 30);
    const standing = makeSession({
      transportMeta: { engineOverride: { originalEngine: "claude", originalAccount: "claude", substituteAccount: FRIEND, substituteConfigDir: "/tmp/friend", until: new Date(Date.now() + 3600_000).toISOString() } } as never,
    });

    served(runStartedMinutesAgo(5, standing));

    expect(readEngineHealth()[FRIEND]?.clearedAt).toBeDefined();
    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });

  it("clears a limit a turn hit on this model, and leaves one a turn hit on another", () => {
    spentMinutesAgo("claude", 30);

    noteTurnServed(runStartedMinutesAgo(5, makeSession({ model: "sonnet" })), "sonnet", { result: answered, silent: false });
    expect(readEngineHealth().claude?.state).toBe("exhausted");

    noteTurnServed(runStartedMinutesAgo(5, makeSession({ model: "opus" })), "opus", { result: answered, silent: false });
    expect(readEngineHealth().claude?.clearedAt).toBeDefined();
  });

  it("keys an opencode model by its provider", () => {
    spentMinutesAgo("opencode/x-provider", 30, "x-provider/model-x");
    spentMinutesAgo("opencode/y-provider", 30, "y-provider/model-y");
    const started = makeSession({ engine: "opencode", model: "x-provider/model-x" });

    noteTurnServed(runStartedMinutesAgo(5, started), "x-provider/model-x", { result: answered, silent: false });

    expect(readEngineHealth()["opencode/x-provider"]?.clearedAt).toBeDefined();
    expect(readEngineHealth()["opencode/y-provider"]?.state).toBe("exhausted");
  });

  describe("an opencode provider's dead key and a model it refused", () => {
    const GO = "opencode-go/kimi-k2";
    /** A dead key on the provider and a refused model, both seen on this machine `minutes` ago. */
    function refusedMinutesAgo(minutes: number): void {
      const now = new Date(Date.now() - minutes * MIN);
      recordOpencodeFailure({ healthKey: "opencode/opencode-go", model: GO, error: "provider.auth: This API key has expired. (HTTP 401)", config: undefined, now });
      recordOpencodeFailure({ healthKey: "opencode/opencode-go", model: GO, error: "provider.auth: Model access is disabled (HTTP 403)", config: undefined, now });
    }
    const goRun = (employee?: object) => {
      const run = runStartedMinutesAgo(5, makeSession({ engine: "opencode", model: GO }));
      return { ...run, input: { ...run.input, employee } } as TurnRun;
    };

    it("are lifted by a turn this machine served on that model", () => {
      refusedMinutesAgo(30);

      noteTurnServed(goRun(), GO, { result: answered, silent: false });

      expect(readEngineHealth()["opencode/opencode-go"]).toMatchObject({ state: "ok", clearedAt: expect.any(String) });
      expect(readEngineHealth()["opencode/opencode-go/kimi-k2"]).toMatchObject({ state: "ok", clearedAt: expect.any(String) });
    });

    it("are left alone by a turn a remote host served: it used that host's key", () => {
      refusedMinutesAgo(30);

      noteTurnServed(goRun({ name: "remote-worker", engine: "opencode", remoteHost: "build-box", remoteUser: "ci", remoteCwd: "/work" }), GO, { result: answered, silent: false });

      expect(readEngineHealth()["opencode/opencode-go"]).toMatchObject({ state: "exhausted", failureClass: "auth" });
      expect(readEngineHealth()["opencode/opencode-go/kimi-k2"]).toMatchObject({ state: "exhausted", failureClass: "model-access" });
    });
  });
});
