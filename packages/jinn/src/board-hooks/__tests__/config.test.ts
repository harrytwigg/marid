import { describe, expect, it } from "vitest";
import { hookProblems, hooksProblems, runnableHooks, hookEvents } from "../../shared/board-hooks-config.js";
import { validateConfigShape } from "../../shared/config.js";

const good = {
  name: "review-merge",
  event: "todo.status_changed",
  match: { from: "executing", to: ["in_review", "done"], label: "auto-merge", actor: ["operator", "employee"] },
  action: { spawn: { employee: "merger", prompt: "go" } },
};

describe("hooksProblems", () => {
  it("accepts an absent block and a good hook with each action", () => {
    expect(hooksProblems(undefined)).toEqual([]);
    expect(hooksProblems([good])).toEqual([]);
    expect(hooksProblems([{ ...good, name: "a", action: { command: { run: "./x.sh", cwd: "/srv" } } }])).toEqual([]);
    expect(hooksProblems([{ ...good, name: "b", event: ["todo.created", "todo.commented"], action: { notify: { connector: "telegram", channel: 123456, thread: null, text: "hi" } } }])).toEqual([]);
  });

  it("rejects a block that is not a list, and a hook that is not a mapping", () => {
    expect(hooksProblems({})).toEqual(["hooks must be a list"]);
    expect(hooksProblems(["nope"])).toEqual(["hooks[0]: must be a mapping"]);
  });

  it("requires a name of [a-z0-9-], 1 to 64 characters", () => {
    for (const name of [undefined, "", "Upper", "has space", "under_score", "x".repeat(65), 7]) {
      expect(hookProblems({ ...good, name }).join()).toMatch(/name must be/);
    }
    expect(hookProblems({ ...good, name: "x".repeat(64) })).toEqual([]);
  });

  it("reports duplicate names", () => {
    const problems = hooksProblems([good, { ...good }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/hooks\[1\] \(review-merge\): duplicate hook name/);
  });

  it("requires a known event", () => {
    expect(hookProblems({ ...good, event: undefined }).join()).toMatch(/event must be/);
    expect(hookProblems({ ...good, event: "todo.deleted" }).join()).toMatch(/unknown event "todo.deleted"/);
    expect(hookProblems({ ...good, event: ["todo.created", "nope"] }).join()).toMatch(/unknown event "nope"/);
    expect(hookProblems({ ...good, event: [] }).join()).toMatch(/event must be/);
  });

  it("requires at least one action", () => {
    expect(hookProblems({ ...good, action: undefined }).join()).toMatch(/action must be a mapping/);
    expect(hookProblems({ ...good, action: {} }).join()).toMatch(/at least one of spawn, command, notify/);
    expect(hookProblems({ ...good, action: { spawn: null } }).join()).toMatch(/at least one of/);
    expect(hookProblems({ ...good, action: { email: {} } }).join()).toMatch(/action.email is not an action/);
  });

  it("requires the fields each action needs", () => {
    expect(hookProblems({ ...good, action: { spawn: {} } })).toEqual(["action.spawn.employee is required"]);
    expect(hookProblems({ ...good, action: { command: {} } })).toEqual(["action.command.run is required"]);
    expect(hookProblems({ ...good, action: { notify: { connector: "telegram" } } }).sort()).toEqual([
      "action.notify.channel is required",
      "action.notify.text is required",
    ]);
    expect(hookProblems({ ...good, action: { notify: { channel: "1", text: "x" } } })).toEqual(["action.notify.connector is required"]);
    expect(hookProblems({ ...good, action: { spawn: "merger" } })).toEqual(["action.spawn must be a mapping"]);
  });

  it("checks match fields and statuses", () => {
    expect(hookProblems({ ...good, match: "x" })).toEqual(["match must be a mapping"]);
    expect(hookProblems({ ...good, match: { colour: "red" } }).join()).toMatch(/match.colour is not a match field/);
    expect(hookProblems({ ...good, match: { label: 3 } }).join()).toMatch(/match.label must be a string or a list/);
    expect(hookProblems({ ...good, match: { to: "finished" } }).join()).toMatch(/match.to names an unknown status "finished"/);
    expect(hookProblems({ ...good, match: null })).toEqual([]);
  });

  it("checks the booleans", () => {
    expect(hookProblems({ ...good, enabled: "yes" })).toEqual(["enabled must be true or false"]);
    expect(hookProblems({ ...good, allowReentry: 1 })).toEqual(["allowReentry must be true or false"]);
  });
});

describe("runnableHooks", () => {
  it("skips bad hooks and later duplicates, keeps the rest, and reports each position", () => {
    const hooks = [{ name: "bad" }, good, { ...good }, { ...good, name: "other" }];
    const runnable = runnableHooks({ hooks });
    expect(runnable.map((entry) => [entry.hook.name, entry.index])).toEqual([["review-merge", 1], ["other", 3]]);
    expect(runnableHooks({})).toEqual([]);
  });

  it("lists a hook's events whether it names one or several", () => {
    expect(hookEvents({ event: "todo.created" })).toEqual(["todo.created"]);
    expect(hookEvents({ event: ["todo.created", "todo.assigned"] })).toEqual(["todo.created", "todo.assigned"]);
  });
});

describe("validateConfigShape", () => {
  it("reports hook problems with the rest of config.yaml", () => {
    const base = { engines: { claude: {} } };
    expect(validateConfigShape({ ...base, hooks: [good] })).toEqual([]);
    expect(validateConfigShape({ ...base, hooks: [{ name: "x" }] }).join()).toMatch(/hooks\[0\] \(x\): event must be/);
  });
});
