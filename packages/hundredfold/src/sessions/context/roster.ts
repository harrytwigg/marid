import { compactEmployeeRole } from "../../shared/employee-role.js";
import type { Employee, OrgHierarchy, OrgNode } from "../../shared/types.js";
import { LEGACY_PORTAL_NAME } from "../../shared/brand.js";

const WORKING_ROSTER_HEADING = "## Working roster (scoped orientation; not exhaustive)";
const FULL_ROSTER_HINT = "Use `find_employees` / `list_employees` for the full roster and `get_employee` for a finalist's full persona.";

/** What every group in one rendering shares. */
interface RosterRender {
  hierarchy: OrgHierarchy;
  portalName: string;
  compact: boolean;
  hundredfoldMcpAttached: boolean;
}

/** One labelled block of rows, capped so a wide org stays bounded. */
interface RosterGroup {
  heading: string;
  names: string[];
  cap: number;
  includeEngine?: boolean;
}

function rosterRole(employee: Employee): string {
  const role = compactEmployeeRole(employee.persona) ?? employee.displayName;
  return role.replace(/[`|]/g, "").replace(/\s+/g, " ").trim();
}

function rosterRow(employee: Employee, includeEngine: boolean): string {
  const engine = includeEngine ? ` · ${employee.engine}` : "";
  return `- \`${employee.name}\` — ${rosterRole(employee)} · ${employee.department}${engine}`;
}

function stablePriority(
  names: string[],
  hierarchy: OrgHierarchy,
  score: (node: OrgNode) => number,
): string[] {
  return names
    .map((name, index) => ({ name, index, score: score(hierarchy.nodes[name]) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ name }) => name);
}

/** Report-holders first, then managers, then everyone else. */
function byStanding(names: string[], hierarchy: OrgHierarchy): string[] {
  return stablePriority(names, hierarchy, (node) => {
    if (node.directReports.length > 0) return 0;
    if (node.employee.rank === "manager") return 1;
    return 2;
  });
}

function topLevelRosterNames(hierarchy: OrgHierarchy, employee?: Employee): string[] {
  const executiveName = hierarchy.root ?? (employee?.rank === "executive" ? employee.name : null);
  const executive = executiveName ? hierarchy.nodes[executiveName] : undefined;
  const roots = hierarchy.sorted.filter((name) => hierarchy.nodes[name]?.parentName === null && name !== executiveName);
  const names = executive?.directReports.length
    ? [...executive.directReports, ...roots]
    : hierarchy.sorted.filter((name) => hierarchy.nodes[name]?.parentName === null);
  return [...new Set(names)].filter((name) => name !== employee?.name && hierarchy.nodes[name]);
}

function appendRosterGroup(lines: string[], group: RosterGroup, render: RosterRender): void {
  if (group.names.length === 0 || group.cap === 0) return;
  const shown = group.names.slice(0, group.cap);
  lines.push("", `${group.heading}:`);
  for (const name of shown) {
    lines.push(rosterRow(render.hierarchy.nodes[name].employee, group.includeEngine === true));
  }
  const omitted = group.names.length - shown.length;
  if (omitted > 0) {
    lines.push(render.hundredfoldMcpAttached ? `+${omitted} more — use \`list_employees\`.` : `+${omitted} more not shown.`);
  }
}

/** The COO's view, and an executive's: the top-level routing lanes. */
function appendTopLevelRoster(lines: string[], employee: Employee | undefined, render: RosterRender): void {
  const { hierarchy, compact } = render;
  if (employee?.rank === "executive") {
    const node = hierarchy.nodes[employee.name];
    if (node?.parentName && hierarchy.nodes[node.parentName]) {
      appendRosterGroup(lines, { heading: "Your manager", names: [node.parentName], cap: 1 }, render);
    }
  }
  appendRosterGroup(lines, {
    heading: "Top-level employees",
    names: byStanding(topLevelRosterNames(hierarchy, employee), hierarchy),
    cap: compact ? 6 : 20,
    includeEngine: true,
  }, render);
}

/**
 * The names beside `employee` — its manager's other reports, or the other roots
 * when it has no manager. Roots are narrowed to the employee's own department
 * for siblings, where an unrelated root is not a sibling in any useful sense.
 */
function lateralNames(
  employee: Employee,
  node: OrgNode,
  hierarchy: OrgHierarchy,
  sameDepartmentOnly: boolean,
): string[] {
  if (node.parentName && hierarchy.nodes[node.parentName]) {
    return hierarchy.nodes[node.parentName].directReports.filter((name) => name !== employee.name);
  }
  return hierarchy.sorted.filter((name) => {
    const other = hierarchy.nodes[name];
    if (other.parentName !== null || name === employee.name) return false;
    return !sameDepartmentOnly || other.employee.department === employee.department;
  });
}

/** An employee's own view: the manager above, then reports and peers, or siblings. */
function appendEmployeeRoster(lines: string[], employee: Employee, render: RosterRender): boolean {
  const { hierarchy, compact, portalName } = render;
  const node = hierarchy.nodes[employee.name];
  if (!node) return false;

  if (node.parentName && hierarchy.nodes[node.parentName]) {
    appendRosterGroup(lines, { heading: "Your manager", names: [node.parentName], cap: 1 }, render);
  } else {
    lines.push("", "Your manager:", `- ${portalName} (COO) — Company coordination and escalation · company`);
  }

  if (node.directReports.length > 0) {
    appendRosterGroup(lines, { heading: "Your direct reports", names: node.directReports, cap: compact ? 4 : 12 }, render);
    appendRosterGroup(lines, {
      heading: "Your peers",
      names: byStanding(lateralNames(employee, node, hierarchy, false), hierarchy),
      cap: compact ? 0 : 6,
    }, render);
    return true;
  }

  const siblings = lateralNames(employee, node, hierarchy, true);
  appendRosterGroup(lines, {
    heading: "Your siblings",
    names: stablePriority(siblings, hierarchy, (sibling) =>
      sibling.employee.department === employee.department ? 0 : 1),
    cap: compact ? 4 : 8,
  }, render);
  return true;
}

function renderScopedRoster(
  employee: Employee | undefined,
  hierarchy: OrgHierarchy | undefined,
  portalName: string,
  compact: boolean,
  hundredfoldMcpAttached: boolean,
): string | null {
  if (!hierarchy || Object.keys(hierarchy.nodes).length === 0) return null;
  const render: RosterRender = { hierarchy, portalName, compact, hundredfoldMcpAttached };
  const lines = [WORKING_ROSTER_HEADING];

  if (!employee || employee.rank === "executive") {
    appendTopLevelRoster(lines, employee, render);
  } else if (!appendEmployeeRoster(lines, employee, render)) {
    return null;
  }

  if (hundredfoldMcpAttached) lines.push("", FULL_ROSTER_HINT);
  return lines.join("\n");
}

/** Build the bounded role-oriented slice injected into fresh session context. */
export function buildScopedRosterSection(
  employee: Employee | undefined,
  hierarchy: OrgHierarchy | undefined,
  portalName = LEGACY_PORTAL_NAME,
  hundredfoldMcpAttached = false,
): string | null {
  return renderScopedRoster(employee, hierarchy, portalName, false, hundredfoldMcpAttached);
}

export function buildScopedRosterSummary(
  employee: Employee | undefined,
  hierarchy: OrgHierarchy | undefined,
  portalName: string,
  hundredfoldMcpAttached: boolean,
): string {
  return renderScopedRoster(employee, hierarchy, portalName, true, hundredfoldMcpAttached)
    ?? (hundredfoldMcpAttached ? `${WORKING_ROSTER_HEADING}\n${FULL_ROSTER_HINT}` : WORKING_ROSTER_HEADING);
}

/**
 * What the roster section says when the org scan failed. The heading still
 * renders: an omitted section reads as "this company has no employees", which
 * is a claim the gateway has no business making off a failed read.
 */
export function buildRosterUnavailableSection(reason: string): string {
  return [
    WORKING_ROSTER_HEADING,
    `⚠️ The org roster could not be read (${reason}). This turn is running without org orientation — the company is not empty. Call \`list_employees\` before delegating.`,
  ].join("\n");
}
