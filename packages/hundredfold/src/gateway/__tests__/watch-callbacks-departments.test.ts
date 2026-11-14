import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshDepartments } from "../department-registry.js";
import { gatewayWatchCallbacks } from "../watch-callbacks.js";
import { resetDepartmentFixtures, writeDepartmentFile } from "./department-fixtures.js";

/** A department's file changing reaches connected clients as company:changed {entity: "department"}. */

beforeEach(() => resetDepartmentFixtures());

describe("gatewayWatchCallbacks", () => {
  it("announces a department whose definition changed after boot, and only that one", () => {
    const emit = vi.fn();
    writeDepartmentFile("side-project", "name: side-project\nscope: scoped\n");
    writeDepartmentFile("quiet", "name: quiet\n");
    refreshDepartments();
    gatewayWatchCallbacks({ reloadConfig: vi.fn(), getConfig: () => ({}), reloadOrg: vi.fn(), emit });
    writeDepartmentFile("side-project", "name: side-project\nscope: dedicated\n");
    refreshDepartments();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("company:changed", { entity: "department", action: "changed", id: "side-project" });
  });
});
