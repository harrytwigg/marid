import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronJob, JinnConfig } from "../../shared/types.js";
import type { ApiContext } from "../../gateway/api.js";

/**
 * A cron fire mints its Todo, then `route()` runs the whole turn before it
 * resolves. The Todo used to be linked to the session only after that, so for
 * the entire turn it read as unstarted and the board walk started a second
 * session on the same brief. The link and the claim have to exist while the
 * turn is still running.
 *
 * Real registry, real `SessionManager.route`; only the engine turn is held open.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-cron-claim-"));
process.env.JINN_HOME = tmp;

vi.mock("../jobs.js", () => ({ appendRunLog: vi.fn() }));
vi.mock("../../gateway/org-registry.js", () => ({ orgRegistry: vi.fn(() => new Map()) }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const job: CronJob = { id: "claim-job", name: "Claim Job", enabled: true, schedule: "0 * * * *", prompt: "do something" };
const config = {
  engines: { default: "claude", claude: { model: "sonnet" } },
  logging: { file: false, stdout: false, level: "info" },
} as unknown as JinnConfig;

beforeAll(async () => {
  (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runCronJob — the Todo is spoken for while its turn runs", () => {
  it("links and claims the Todo before the turn ends, so no second session can be started on it", async () => {
    const { runCronJob } = await import("../runner.js");
    const { SessionManager } = await import("../../sessions/manager.js");
    const { beginSessionAttempt, listSessionsByWorkItem } = await import("../../sessions/registry.js");
    const { listWorkItems } = await import("../../work-items/store.js");
    const { getWorkItemClaim } = await import("../../work-items/claims.js");
    const { takeDispatchClaim } = await import("../../gateway/todo-claim.js");
    const { startTodoDispatcher } = await import("../../gateway/todo-dispatch.js");

    let releaseTurn!: () => void;
    const turnHeldOpen = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let turnStarted!: () => void;
    const turnStart = new Promise<void>((resolve) => { turnStarted = resolve; });

    const manager = new SessionManager(config, new Map(), "boot");
    // The engine turn: what `runSession` does first, then it just takes its time.
    vi.spyOn(manager as unknown as { runSession: (session: { id: string }) => Promise<void> }, "runSession")
      .mockImplementation(async (session) => {
        beginSessionAttempt(session.id);
        turnStarted();
        await turnHeldOpen;
      });

    const fire = runCronJob(job, manager, config, new Map());
    await turnStart;

    // The turn is still running: this is the window the board walk used to land in.
    const [item] = listWorkItems({ source: "cron" });
    expect(item).toBeDefined();
    const linked = listSessionsByWorkItem(item!.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ status: "running", source: "cron" });
    expect(getWorkItemClaim(item!.id)).toMatchObject({ owner: "cron:claim-job", sessionId: linked[0]!.id });

    const claim = takeDispatchClaim(item!.id);
    expect(claim).toMatchObject({ state: "refused", status: 409, body: { code: "TODO_ALREADY_EXECUTING", sessionId: linked[0]!.id } });
    const dispatched = startTodoDispatcher(item!, {} as ApiContext);
    expect(dispatched).toMatchObject({ ok: false, status: 409, body: { sessionId: linked[0]!.id } });
    expect(listSessionsByWorkItem(item!.id)).toHaveLength(1);

    releaseTurn();
    await fire;
  });
});
