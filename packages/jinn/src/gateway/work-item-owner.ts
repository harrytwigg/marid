import { getSession, listSessionsByWorkItem } from "../sessions/registry.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { Employee } from "../shared/types.js";
import type { WorkItem } from "../work-items/store.js";
import { resolveOrgHierarchy } from "./org-hierarchy.js";
import { orgRegistry } from "./org-registry.js";

/**
 * Who a Todo belongs to, and who sits at the top of the org. The standing
 * checks in `work-item-authority.ts` ask both on the way into assign, archive,
 * dispatch, delegate and status; quick capture and the needs-attention inbox
 * ask the root.
 */

export type OrgRootKind = "employee" | "virtual";

export interface OrgRoot {
  name: string;
  department: string | null;
  kind: OrgRootKind;
}

const warnedPortalRootCollisions = new Set<string>();

function configuredPortalName(): string {
  try {
    const portalName = loadConfig().portal?.portalName?.trim();
    if (portalName) return portalName;
  } catch {
    // Tests and partially-seeded homes may not have a complete config yet.
  }
  return "Jinn";
}

/** With no employee at the top of the tree, the portal is the root: a virtual
 *  one, under a name no employee holds, so no employee inherits its standing. */
function portalRoot(registry: Map<string, Employee>): OrgRoot | null {
  const configuredName = configuredPortalName();
  if (!registry.has(configuredName)) return { name: configuredName, department: null, kind: "virtual" };

  if (!warnedPortalRootCollisions.has(configuredName)) {
    warnedPortalRootCollisions.add(configuredName);
    logger.warn(`portal.portalName "${configuredName}" collides with an org employee; ignoring it as the org root so employee authority cannot inherit virtual COO authority`);
  }

  for (const candidate of ["Jinn", "Portal COO", "operator", "COO"]) {
    if (candidate !== configuredName && !registry.has(candidate)) {
      return { name: candidate, department: null, kind: "virtual" };
    }
  }

  logger.warn("No collision-free virtual org root name is available; root standing is disabled until portal.portalName is distinct from org employees");
  return null;
}

/** The org root: the employee at the top of the hierarchy, or the portal. */
export function resolveOrgRoot(): OrgRoot | null {
  const registry = orgRegistry();
  const root = resolveOrgHierarchy(registry).root;
  if (root) return { name: root, department: registry.get(root)?.department ?? null, kind: "employee" };
  return portalRoot(registry);
}

/** The session that produced this Todo, read off its provenance.
 *
 *  Exported because quick capture needs the SAME answer the owner walk uses:
 *  the Todo a Shaper may dispatch has to be the Todo its capture reports, and
 *  two definitions of "which session made this" would eventually disagree
 *  about exactly that. Note it is `sourceRef`, not `createdBy` — `createdBy`
 *  records the employee, so it cannot tell two captures apart. */
export function sourceSessionId(item: WorkItem): string | null {
  if (!item.sourceRef) return null;
  const sessionMatch = /^session:([^:]+):/.exec(item.sourceRef);
  if (sessionMatch) return sessionMatch[1];
  const delegateMatch = /^delegate:([^:]+):/.exec(item.sourceRef);
  if (delegateMatch) return delegateMatch[1];
  return null;
}

function firstKnownLinkedEmployee(item: WorkItem, registry: Map<string, Employee>): string | null {
  for (const session of listSessionsByWorkItem(item.id)) {
    if (session.employee && registry.has(session.employee)) return session.employee;
  }
  return null;
}

function sourceEmployee(item: WorkItem, registry: Map<string, Employee>): string | null {
  const id = sourceSessionId(item);
  if (!id) return null;
  const session = getSession(id);
  return session?.employee && registry.has(session.employee) ? session.employee : null;
}

/** The employee a Todo belongs to: its assignee when that is on the roster,
 *  else the first rostered employee with a session linked to it, else the
 *  employee whose session created it. */
export function resolveWorkItemOwner(item: WorkItem): string | null {
  const registry = orgRegistry();
  if (item.assignee && registry.has(item.assignee)) return item.assignee;
  return firstKnownLinkedEmployee(item, registry) ?? sourceEmployee(item, registry);
}
