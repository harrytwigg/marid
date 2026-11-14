import { getSession, listSessionsByWorkItem } from "../../sessions/registry.js";
import type { SessionTreeNode, SessionTreeResponse } from "../../sessions/session-tree.js";
import { isTodoId } from "../../work-items/id.js";
import type { WorkItemRelationView } from "../../work-items/relations.js";
import { getWorkItem } from "../../work-items/store.js";
import { json } from "../route-helpers.js";
import { fullWorkItemPayload } from "../work-item-payload.js";
import type { GateRequest } from "./gate.js";
import { todoInDepartment } from "./gate.js";

/**
 * The two Todo reads the gate serves itself, because the route's answer names things
 * outside D: a Todo's relations (FR-011's linking rule: "sees any relation to a non-D
 * Todo as a hidden count") and the sessions working it (FR-009: an unscoped session is
 * never visible to a scoped one). Each answers in the route's own shape, with the
 * hidden rows removed and counted.
 */

export function serveTodoRead(g: GateRequest): boolean {
  const id = g.rule.params.id;
  const item = isTodoId(id) ? getWorkItem(id) : undefined;
  if (!item) return false;
  const payload = fullWorkItemPayload(item);
  const relations = (payload.relations ?? []) as WorkItemRelationView[];
  const visible = relations.filter((relation) => todoInDepartment(relation.other.id, g.caller.department));
  json(g.res, { ...payload, relations: visible, hiddenRelations: relations.length - visible.length });
  return true;
}

/** The bound nodes of a tree; an unbound node is replaced by its bound descendants. */
function keepBound(nodes: readonly SessionTreeNode[], department: string, hidden: { count: number }): SessionTreeNode[] {
  return nodes.flatMap((node) => {
    const children = keepBound(node.children, department, hidden);
    if (node.scopeDepartment === department) return [{ ...node, children }];
    hidden.count += 1;
    return children;
  });
}

function countNodes(nodes: readonly SessionTreeNode[]): { nodes: number; live: number } {
  return nodes.reduce((sum, node) => {
    const below = countNodes(node.children);
    return { nodes: sum.nodes + 1 + below.nodes, live: sum.live + (node.status === "running" ? 1 : 0) + below.live };
  }, { nodes: 0, live: 0 });
}

function boundTree(tree: SessionTreeResponse, department: string): SessionTreeResponse & { hiddenCount: number } {
  const hidden = { count: 0 };
  const roots = keepBound(tree.roots, department, hidden);
  const directory = Object.fromEntries(
    Object.entries(tree.directory).filter(([id]) => getSession(id)?.scopeDepartment === department),
  );
  return { ...tree, roots, directory, totals: countNodes(roots), hiddenCount: hidden.count };
}

export function serveTodoSessions(g: GateRequest): boolean {
  const id = g.rule.params.id;
  if (!isTodoId(id)) return false;
  if (g.route.url.searchParams.get("tree") === "1") {
    json(g.res, boundTree(g.deps.readSessionTree(id), g.caller.department));
    return true;
  }
  // The flat form is a bare array, so it carries no count: the tree form does.
  const linked = listSessionsByWorkItem(id).filter((session) => session.scopeDepartment === g.caller.department);
  json(g.res, g.deps.serializeSessions(linked));
  return true;
}
