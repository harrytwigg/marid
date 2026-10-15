import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { JinnConfig } from "../../shared/types.js";

/**
 * A department-scoped employee's sessions run only on claude, so an engine
 * override that is not claude on a Todo of a scoped department (or held by a
 * scoped employee) can never run. It is refused when set, and one stored before
 * that was true is refused at dispatch with the way out.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-dispatch-scoped-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type DispatchConfig = typeof import("../dispatch-config.js");
type Scope = typeof import("../department-scope.js");
let store: Store;
let dispatch: DispatchConfig;
let scope: Scope;

const SCOPED_MEMBER = "lab-dev";
const OPEN_MEMBER = "platform-dev";

beforeAll(async () => {
  (await import("../../shared/db.js")).initDb();
  store = await import("../store.js");
  dispatch = await import("../dispatch-config.js");
  scope = await import("../department-scope.js");
  scope.setEmployeeDepartmentResolver((employee) => (employee === SCOPED_MEMBER ? "lab" : employee === OPEN_MEMBER ? "platform" : undefined));
  scope.setDepartmentScopeResolver((department) => (department === "lab" ? "scoped" : "open"));
});

afterAll(() => {
  scope.setEmployeeDepartmentResolver(null);
  scope.setDepartmentScopeResolver(null);
});

function config(): JinnConfig {
  return {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.6-sol" },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", supportsEffort: false }] },
      codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol", supportsEffort: false }] },
    },
  } as unknown as JinnConfig;
}

function todo(title: string, department: string | undefined, assignee?: string): string {
  return store.createWorkItem({ title, source: "human", ...(department ? { department } : {}), ...(assignee ? { assignee } : {}) }).id;
}

describe("a non-claude engine override on a scoped department's Todo", () => {
  it("is refused when set, with the scoped-engine message, and writes nothing", () => {
    const id = todo("scoped dept", "lab");
    const result = dispatch.setTodoDispatchConfig(id, { engine: "codex" }, config());

    expect(result.ok).toBe(false);
    const error = result.ok === false ? result.error : "";
    expect(error).toContain('department "lab"');
    expect(error).toContain("run only on the claude engine");
    expect(error).toContain('"codex"');
    expect(dispatch.getTodoDispatchConfig(id)).toBeUndefined();
  });

  it("is refused for a sub-task whose root sits in the scoped department", () => {
    const root = todo("scoped root", "lab");
    const child = store.createWorkItem({ title: "child", source: "human", parentId: root }).id;
    expect(dispatch.setTodoDispatchConfig(child, { engine: "codex" }, config()).ok).toBe(false);
  });

  it("is refused for a scoped assignee, in the words a scoped session start would use", () => {
    const id = todo("scoped assignee", "lab", SCOPED_MEMBER);
    const result = dispatch.setTodoDispatchConfig(id, { engine: "codex" }, config());

    expect(result.ok).toBe(false);
    const error = result.ok === false ? result.error : "";
    expect(error).toContain(`employee "${SCOPED_MEMBER}" is confined to department "lab"`);
    expect(dispatch.getTodoDispatchConfig(id)).toBeUndefined();
  });

  it("still accepts claude, and clearing the override", () => {
    const id = todo("scoped claude", "lab");
    expect(dispatch.setTodoDispatchConfig(id, { engine: "claude", model: "opus" }, config()).ok).toBe(true);
    expect(dispatch.setTodoDispatchConfig(id, { engine: null, model: null }, config()).ok).toBe(true);
  });
});

describe("the same override on an open department's Todo", () => {
  it("is accepted", () => {
    const id = todo("open dept", "platform", OPEN_MEMBER);
    expect(dispatch.setTodoDispatchConfig(id, { engine: "codex" }, config()).ok).toBe(true);
    expect(dispatch.getTodoDispatchConfig(id)).toMatchObject({ engine: "codex" });
  });

  it("is accepted on a Todo with no department and no assignee", () => {
    const id = todo("no dept", undefined);
    expect(dispatch.setTodoDispatchConfig(id, { engine: "codex" }, config()).ok).toBe(true);
  });
});

describe("an override stored before its Todo was scoped", () => {
  function storeBadOverride(id: string): void {
    // Set while the department was open, as it would have been before it was scoped.
    scope.setDepartmentScopeResolver(() => "open");
    try {
      expect(dispatch.setTodoDispatchConfig(id, { engine: "codex" }, config()).ok).toBe(true);
    } finally {
      scope.setDepartmentScopeResolver((department) => (department === "lab" ? "scoped" : "open"));
    }
  }

  it("is surfaced at dispatch, naming the Todo and the way out, instead of being honoured", () => {
    const id = todo("stale override", "lab");
    storeBadOverride(id);

    const resolved = dispatch.resolveTodoDispatch(id, SCOPED_MEMBER);
    expect(resolved.ok).toBe(false);
    const error = resolved.ok === false ? resolved.error : "";
    expect(error).toContain(id);
    expect(error).toContain("engine: null");
    expect(error).toContain("run only on the claude engine");
  });

  it("is surfaced for a delegation that names no employee, since the department alone refuses it", () => {
    const id = todo("stale override, no employee", "lab");
    storeBadOverride(id);
    expect(dispatch.resolveTodoDispatch(id, null).ok).toBe(false);
  });

  it("does not trap a patch that leaves the override alone, and clearing it unblocks dispatch", () => {
    const id = todo("stale override, patched", "lab");
    storeBadOverride(id);

    expect(dispatch.setTodoDispatchConfig(id, { autoStart: false }, config()).ok).toBe(true);
    expect(dispatch.setTodoDispatchConfig(id, { engine: null }, config()).ok).toBe(true);
    expect(dispatch.resolveTodoDispatch(id, SCOPED_MEMBER).ok).toBe(true);
  });

  it("does not touch an override on an open department's Todo", () => {
    const id = todo("open override", "platform", OPEN_MEMBER);
    expect(dispatch.setTodoDispatchConfig(id, { engine: "codex" }, config()).ok).toBe(true);
    const resolved = dispatch.resolveTodoDispatch(id, OPEN_MEMBER);
    expect(resolved.ok && resolved.preamble.engine).toBe("codex");
  });
});
