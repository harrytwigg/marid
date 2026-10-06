import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCronJob } from "../runner.js";
import { appendRunLog } from "../jobs.js";
import { refreshOrg } from "../../gateway/org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "../../gateway/__tests__/department-fixtures.js";
import type { CronJob, JinnConfig } from "../../shared/types.js";

/**
 * A cron job that targets a department-scoped employee never runs: the API refuses to
 * store one, and the runner refuses a hand-written entry in jobs.json the same way.
 */

vi.mock("../jobs.js", () => ({ appendRunLog: vi.fn() }));

const config = { engines: { default: "claude", claude: {} }, logging: { file: false, stdout: false, level: "error" } } as unknown as JinnConfig;
const job = (employee: string): CronJob => ({ id: `hand-written-${employee}`, name: "Hand written", enabled: true, schedule: "0 * * * *", prompt: "do it", employee });

beforeEach(() => {
  vi.clearAllMocks();
  resetDepartmentFixtures();
  writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
  writeEmployeeFile("side-project", "side-dev");
  writeEmployeeFile("engineering", "eng-dev");
  refreshOrg(config);
});

describe("runCronJob for a scoped employee", () => {
  it("starts no session, and records why in the run log", async () => {
    const route = vi.fn().mockResolvedValue({ sessionId: "sess-1" });
    await runCronJob(job("side-dev"), { route } as never, config, new Map(), {});
    expect(route).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendRunLog).mock.calls[0]![1]).toMatchObject({
      status: "error",
      error: 'cron jobs cannot target side-dev, who is confined to department "side-project"; cron stays company-level',
    });
  });

  it("runs the same job for an unscoped employee", async () => {
    const route = vi.fn().mockResolvedValue({ sessionId: "sess-1" });
    await runCronJob(job("eng-dev"), { route } as never, config, new Map(), {});
    expect(route).toHaveBeenCalledTimes(1);
  });
});
