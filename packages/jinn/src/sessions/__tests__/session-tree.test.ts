import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types.js";
import {
  SESSION_TREE_MAX_DEPTH,
  SESSION_TREE_MAX_NODES,
  buildSessionTree,
  sessionIdFromActor,
  type SessionTreeNode,
} from "../session-tree.js";

const TODO = "TST-81";

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    engine: "codex",
    engineSessionId: null,
    source: "web",
    sourceRef: `web:${id}`,
    connector: "web",
    sessionKey: `web:${id}`,
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-07-20T10:00:00.000Z",
    lastActivity: "2026-07-20T10:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

/** Every id in the tree, so a walk can be checked without pinning its shape. */
function ids(nodes: readonly SessionTreeNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...ids(node.children)]);
}

function find(nodes: readonly SessionTreeNode[], id: string): SessionTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = find(node.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/** A chain of `length` sessions below `root`, each the child of the last. */
function chain(root: string, length: number): Session[] {
  return Array.from({ length }, (_, i) => session(`${root}-d${i + 1}`, { parentSessionId: i === 0 ? root : `${root}-d${i}` }));
}

describe("buildSessionTree", () => {
  it("nests a delegated child under the linked session rather than flattening it", () => {
    const tree = buildSessionTree({
      todoId: TODO,
      sessions: [
        session("root", { workItemId: TODO, employee: "todo-dispatcher" }),
        session("child", { parentSessionId: "root", employee: "senior-developer" }),
        session("grandchild", { parentSessionId: "child", employee: "qa" }),
      ],
    });

    expect(tree.roots.map((n) => n.id)).toEqual(["root"]);
    expect(find(tree.roots, "child")?.children.map((n) => n.id)).toEqual(["grandchild"]);
    expect(find(tree.roots, "child")?.employee).toBe("senior-developer");
    expect(tree.totals.nodes).toBe(3);
  });

  it("terminates on a parent cycle without a session becoming its own descendant", () => {
    const tree = buildSessionTree({
      todoId: TODO,
      sessions: [
        session("root", { workItemId: TODO, parentSessionId: "b" }),
        session("a", { parentSessionId: "root" }),
        session("b", { parentSessionId: "a" }),
      ],
    });

    const walked = ids(tree.roots);
    expect(walked).toEqual(["root", "a", "b"]);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it("does not attach a session reachable by two paths twice", () => {
    const tree = buildSessionTree({
      todoId: TODO,
      sessions: [
        session("root-a", { workItemId: TODO }),
        session("root-b", { workItemId: TODO }),
        session("shared", { parentSessionId: "root-a" }),
        session("shared-child", { parentSessionId: "shared" }),
      ],
    });

    expect(ids(tree.roots).filter((id) => id === "shared")).toHaveLength(1);
  });

  it("marks the node whose children the depth bound withheld", () => {
    const overflow = SESSION_TREE_MAX_DEPTH + 1;
    const tree = buildSessionTree({
      todoId: TODO,
      sessions: [session("root", { workItemId: TODO }), ...chain("root", overflow)],
    });

    expect(tree.truncated.depth).toBe(true);
    // The deepest node that was reached still has an unexplored child below it.
    const last = find(tree.roots, `root-d${SESSION_TREE_MAX_DEPTH}`);
    expect(last?.truncated).toEqual({ reason: "depth" });
    expect(find(tree.roots, `root-d${overflow}`)).toBeUndefined();
  });

  it("stops at the node budget and says so instead of returning a short tree silently", () => {
    const wide = Array.from({ length: SESSION_TREE_MAX_NODES + 10 }, (_, i) =>
      session(`c${i}`, { parentSessionId: "root" }),
    );
    const tree = buildSessionTree({ todoId: TODO, sessions: [session("root", { workItemId: TODO }), ...wide] });

    expect(tree.truncated.count).toBe(true);
    expect(tree.totals.nodes).toBe(SESSION_TREE_MAX_NODES);
    expect(tree.roots[0]?.truncated).toEqual({ reason: "count" });
  });

  it("reads a null link role as an execution attempt and keeps an explicit review", () => {
    const tree = buildSessionTree({
      todoId: TODO,
      sessions: [
        session("worker", { workItemId: TODO }),
        session("reviewer", { workItemId: TODO, workItemRole: "review" }),
      ],
    });

    expect(find(tree.roots, "worker")?.role).toBe("execute");
    expect(find(tree.roots, "reviewer")?.role).toBe("review");
  });

  it("keeps an archived session in the tree, marked", () => {
    const tree = buildSessionTree({
      todoId: TODO,
      sessions: [session("root", { workItemId: TODO, archivedAt: "2026-07-21T09:00:00.000Z" })],
    });

    expect(find(tree.roots, "root")?.archived).toBe(true);
  });

  it("counts only live sessions in the live total", () => {
    const tree = buildSessionTree({
      todoId: TODO,
      sessions: [
        session("running", { workItemId: TODO, status: "running" }),
        session("waiting", { parentSessionId: "running", status: "waiting" }),
        session("done", { parentSessionId: "running", status: "idle" }),
      ],
    });

    expect(tree.totals).toEqual({ nodes: 3, live: 2 });
  });

  it("resolves a referenced session that is not linked to the Todo — the creator case", () => {
    const tree = buildSessionTree({
      todoId: TODO,
      sessions: [session("linked", { workItemId: TODO }), session("creator", { employee: "coo" })],
      referencedSessionIds: ["creator"],
    });

    expect(ids(tree.roots)).toEqual(["linked"]);
    expect(tree.directory.creator).toMatchObject({ employee: "coo", missing: false });
  });

  it("reports a referenced id with no session row as missing rather than omitting it", () => {
    const tree = buildSessionTree({
      todoId: TODO,
      sessions: [session("linked", { workItemId: TODO })],
      referencedSessionIds: ["gone"],
    });

    expect(tree.directory.gone).toMatchObject({ id: "gone", missing: true, employee: null });
  });

  it("carries each session's background and delegated activity so a reader can say what a finished turn waits on", () => {
    const monitor = { activeStreams: 0, activeMonitors: 1, lastActivityAt: "2026-07-20T10:05:00.000Z" };
    const sessions = [session("a", { workItemId: TODO }), session("b", { parentSessionId: "a" })];

    const { roots } = buildSessionTree({
      todoId: TODO,
      sessions,
      activity: {
        backgroundActivity: (s) => (s.id === "a" ? monitor : null),
        delegatedActivity: (s) => (s.id === "a" ? { activeSessions: 1, employees: ["junior-developer"] } : null),
      },
    });

    expect(roots[0].backgroundActivity).toEqual(monitor);
    expect(roots[0].delegatedActivity).toEqual({ activeSessions: 1, employees: ["junior-developer"] });
    expect(roots[0].children[0].backgroundActivity).toBeNull();
    expect(roots[0].children[0].delegatedActivity).toBeNull();
  });

  it("reports no activity on any node when the caller supplies none", () => {
    const { roots } = buildSessionTree({ todoId: TODO, sessions: [session("a", { workItemId: TODO })] });
    expect(roots[0].backgroundActivity).toBeNull();
    expect(roots[0].delegatedActivity).toBeNull();
  });

  it("returns an empty tree for a Todo nothing is linked to", () => {
    const tree = buildSessionTree({ todoId: TODO, sessions: [session("elsewhere", { workItemId: "TST-9" })] });

    expect(tree.roots).toEqual([]);
    expect(tree.totals).toEqual({ nodes: 0, live: 0 });
    expect(tree.truncated).toEqual({ depth: false, count: false });
  });
});

describe("sessionIdFromActor", () => {
  it("takes the id off a session actor and refuses anything else", () => {
    expect(sessionIdFromActor("session:abc")).toBe("abc");
    expect(sessionIdFromActor("operator")).toBeNull();
    expect(sessionIdFromActor("session:")).toBeNull();
    expect(sessionIdFromActor(null)).toBeNull();
  });
});
