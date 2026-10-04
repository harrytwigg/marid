import type { JinnConfig } from "../shared/types.js";
import type { WorkItem } from "../work-items/store.js";
import { orgRegistry } from "./org-registry.js";
import { remoteMcpHasOperatorStanding } from "./remote-mcp/rules.js";
import { workItemActor, type WorkItemCaller } from "./work-item-arming.js";

/**
 * Two standings the Todo routes share, in one place so the routes that use them
 * cannot drift apart.
 *
 * - Retagging a Todo — changing its labels or moving it between sprints — is
 *   the operator's (or the operator's connector's), its creator's, or its
 *   assignee's.
 * - Organising the company's tags — creating labels, planning sprints — is the
 *   operator's or a manager's: an employee with direct reports. The connector
 *   gets no standing of its own here; its route allowlist does not reach these
 *   routes at all.
 */

export function mayRetagTodo(caller: WorkItemCaller, item: Pick<WorkItem, "createdBy" | "assignee">): boolean {
  if (caller.kind === "operator" || remoteMcpHasOperatorStanding(caller)) return true;
  if (item.createdBy === workItemActor(caller)) return true;
  const employee = caller.session.employee ?? null;
  return employee !== null && (item.assignee === employee || item.createdBy === employee);
}

export async function mayOrganiseTags(caller: WorkItemCaller, config: JinnConfig): Promise<boolean> {
  if (caller.kind === "operator") return true;
  const employee = caller.session.employee;
  if (!employee) return false;
  const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
  const node = resolveOrgHierarchy(orgRegistry(config)).nodes[employee];
  return (node?.directReports.length ?? 0) > 0;
}
