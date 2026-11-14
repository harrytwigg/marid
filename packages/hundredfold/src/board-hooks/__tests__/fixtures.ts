import type { BasePayload, HookPayload } from "../types.js";

export function basePayload(overrides: Partial<BasePayload> = {}): BasePayload {
  return {
    version: 1,
    event: "todo.status_changed",
    eventId: "wie_1",
    at: "2026-01-01T12:00:00.000Z",
    todo: {
      id: "TSK-12", title: "Ship it", status: "in_review", department: "platform", labels: ["auto-merge"],
      assignee: "senior-developer", parentId: null, rootId: "TSK-12", childIds: [], reviewAddressee: { kind: "operator" }, url: "/todos/TSK-12",
    },
    from: "executing",
    to: "in_review",
    actor: { raw: "operator", kind: "operator" },
    text: null,
    prUrl: null,
    sessionId: null,
    ...overrides,
  };
}

export function hookPayload(overrides: Partial<HookPayload> = {}): HookPayload {
  return { ...basePayload(), fireId: "bhf_1", hook: "review-merge", chain: ["review-merge"], ...overrides };
}
