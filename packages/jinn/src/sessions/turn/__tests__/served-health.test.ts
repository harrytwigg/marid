import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A turn that ran and was answered clears a limit its target still holds, when the
 * turn began after the limit was recorded. It is read off the live row, so a
 * session standing on a substitute clears the substitute and not its own account.
 */

const tmp = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/jinn-served-health-${process.pid}`);
vi.mock("../../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/paths.js")>()),
  JINN_HOME: tmp,
}));

import { noteTurnServed } from "../served-health.js";
import { readEngineHealth, recordEngineUnavailable } from "../../../shared/engine-health.js";
import { makeSession } from "../../__tests__/helpers/session-fixture.js";
import type { EngineResult, Session } from "../../../shared/types.js";
import type { TurnRun } from "../types.js";

const STATE_PATH = path.join(tmp, "tmp", "engine-health.json");
const MIN = 60_000;
const FRIEND = "claude:friend01";
const answered: EngineResult = { sessionId: "t", result: "done", cost: 0.01 };

const spentMinutesAgo = (key: string, minutes: number) =>
  recordEngineUnavailable(key, "usage limit", (Date.now() + 4 * 24 * 60 * MIN) / 1000, new Date(Date.now() - minutes * MIN));

function runStartedMinutesAgo(minutes: number): TurnRun {
  return { input: { employee: undefined }, plan: { engineConfig: { model: "opus" } }, turnStartedAt: Date.now() - minutes * MIN } as unknown as TurnRun;
}

const served = (run: TurnRun, live: Session, result: EngineResult = answered, silent = false) => noteTurnServed(run, live, "opus", { result, silent });

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});
afterEach(() => fs.rmSync(STATE_PATH, { recursive: true, force: true }));

describe("noteTurnServed", () => {
  it("clears the record of the account the turn ran on", () => {
    spentMinutesAgo("claude", 30);

    served(runStartedMinutesAgo(5), makeSession());

    expect(readEngineHealth().claude).toMatchObject({ state: "ok", clearedAt: expect.any(String), reason: "a turn was served" });
  });

  it("does not clear on a turn that began before the limit was recorded", () => {
    spentMinutesAgo("claude", 5);

    served(runStartedMinutesAgo(30), makeSession());

    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });

  it.each([
    ["a preempted, dead or limited turn", answered, true],
    ["a turn that ended in an error", { ...answered, error: "boom" }, false],
    ["a clean turn that produced nothing and cost nothing", { sessionId: "t", result: "" }, false],
  ])("says nothing for %s", (_name, result, silent) => {
    spentMinutesAgo("claude", 30);

    served(runStartedMinutesAgo(5), makeSession(), result as EngineResult, silent);

    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });

  it("clears the substitute account a session stands on, and leaves its own account's record alone", () => {
    spentMinutesAgo("claude", 30);
    spentMinutesAgo(FRIEND, 30);
    const standing = makeSession({
      transportMeta: { engineOverride: { originalEngine: "claude", originalAccount: "claude", substituteAccount: FRIEND, substituteConfigDir: "/tmp/friend", until: new Date(Date.now() + 3600_000).toISOString() } } as never,
    });

    served(runStartedMinutesAgo(5), standing);

    expect(readEngineHealth()[FRIEND]?.clearedAt).toBeDefined();
    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });

  it("keys an opencode model by its provider", () => {
    spentMinutesAgo("opencode/x-provider", 30);
    spentMinutesAgo("opencode/y-provider", 30);
    const live = makeSession({ engine: "opencode", model: "x-provider/model-x" });

    noteTurnServed(runStartedMinutesAgo(5), live, "x-provider/model-x", { result: answered, silent: false });

    expect(readEngineHealth()["opencode/x-provider"]?.clearedAt).toBeDefined();
    expect(readEngineHealth()["opencode/y-provider"]?.state).toBe("exhausted");
  });
});
