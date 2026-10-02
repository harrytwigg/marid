/**
 * What the orb knows before anyone speaks.
 *
 * A voice session that has to be told what a Workflow is spends its first turn
 * on a question the gateway can already answer, so the brief goes out with the
 * session rather than being asked for. Everything specific to the instance —
 * the company, its Todo prefix, who works here — is read at runtime; nothing
 * about any particular operator is written down here.
 *
 * The brief is `instructions`, a replaced field, so it costs its length once per
 * push rather than once per turn. It is still capped: {@link
 * TALK_BRIEF_BUDGET_CHARS} bounds it, and the roster is the only part allowed to
 * give ground. A large org loses employee rows before it loses the glossary,
 * because an orb that can name three hundred people but cannot say what a
 * Workflow is has kept the wrong half.
 */
import { resolveOrgHierarchy } from "../../gateway/org-hierarchy.js";
import type { Employee, JinnConfig, OrgHierarchy } from "../../shared/types.js";
import { resolveTodoIdPrefix } from "../../work-items/id.js";

/** ~750 tokens at the four-chars-per-token estimate in `context.ts`. Sent once
 *  per `session.update`, against a turn budget of `TALK_CONTEXT_BUDGET_TOKENS`
 *  that it does not touch. */
export const TALK_BRIEF_BUDGET_CHARS = 3000;

/** How much of an operator-typed company name the brief carries. The doctrine
 *  has to be fixed-size for the roster ladder's arithmetic to hold. */
const COMPANY_NAME_CHARS = 60;

/** Leaders before the rest, so a truncated department still names who runs it. */
const RANK_ORDER: readonly string[] = ["executive", "manager", "senior", "employee"];

/**
 * How much of the org survived the budget. `empty` is an instance with no
 * employees at all, which is a real state on a fresh install rather than a
 * degradation.
 */
export type RosterLevel = "full" | "summary" | "counts" | "empty";

export interface StandingBrief {
  text: string;
  rosterLevel: RosterLevel;
}

const POSTURE =
  "You are the voice of this Jinn instance: the operator's COO-grade assistant, not a chatbot. "
  + "You already know this company, so answer from what follows and reach for a tool only when you need something live. "
  + "Lead with the answer and keep it short. Anything outward-facing — a message sent, a change committed, money spent — "
  + "gets the situation stated plainly first and the operator's go-ahead before it happens.";

const WHAT_JINN_IS =
  "Jinn is a self-hosted gateway that runs a company of AI employees. One process holds the org, "
  + "routes work to engine sessions, runs scheduled jobs and workflows, and serves the web UI the operator is looking at.";

const BLOCKS = [
  "The blocks the company is built from:",
  "- Todo — one tracked outcome, and the company's live work ledger. It has an owner, a status and a history, and it is done once.",
  "- Workflow — a reusable procedure: the saved HOW for work that repeats. It is not a Todo. Running one creates Todos of its own; the Workflow itself is never finished.",
  "- Employee — a persona with a department, a rank and a manager. Work is delegated to employees, who run as sessions.",
  "- Chat — one conversation with an employee.",
  "- Note — durable Markdown knowledge the company keeps.",
].join("\n");

/** The company's own name, prefix and statuses. Fixed-size by construction: the
 *  only variable parts are the clipped company name and a three-letter prefix. */
function identity(config: Pick<JinnConfig, "portal">): string {
  const configured = config.portal?.companyName ?? "Jinn";
  const prefix = resolveTodoIdPrefix(configured, config.portal?.companyPrefix);
  return (
    `This instance is ${configured.slice(0, COMPANY_NAME_CHARS)}. `
    + `Its Todos are numbered ${prefix}-1, ${prefix}-2 and so on, and they move through eight statuses: `
    + "backlog (nobody has picked it up), assigned (owned, not started), executing (in progress), "
    + "in_review (the producer is finished and a reviewer has it), done (closed by that reviewer, never by the producer), "
    + "blocked (waiting on something else), escalated (needs the operator), cancelled (dropped)."
  );
}

interface Department {
  name: string;
  /** Leaders first, then alphabetical. */
  members: Employee[];
}

function byRankThenName(a: Employee, b: Employee): number {
  const rankGap = RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
  return rankGap === 0 ? a.name.localeCompare(b.name) : rankGap;
}

function departmentsOf(registry: Map<string, Employee>): Department[] {
  const grouped = new Map<string, Employee[]>();
  for (const employee of registry.values()) {
    const members = grouped.get(employee.department);
    if (members) members.push(employee);
    else grouped.set(employee.department, [employee]);
  }
  return [...grouped.entries()]
    .map(([name, members]) => ({ name, members: [...members].sort(byRankThenName) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The line every roster level opens with, so the headcount is known even when
 *  no individual survived the budget. */
function heading(total: number, departments: number): string {
  const people = total === 1 ? "employee" : "employees";
  const units = departments === 1 ? "department" : "departments";
  return `Who works here — ${total} ${people} across ${departments} ${units}:`;
}

/** One row per employee, carrying the reporting line: "who works here" is half
 *  names and half who answers to whom. */
function fullRoster(departments: Department[], hierarchy: OrgHierarchy, total: number): string {
  const lines = [heading(total, departments.length)];
  for (const department of departments) {
    lines.push(`${department.name}:`);
    for (const member of department.members) {
      const parent = hierarchy.nodes[member.name]?.parentName;
      const reports = parent ? `, reports to ${parent}` : "";
      lines.push(`  ${member.displayName} (${member.name}) — ${member.rank}${reports}`);
    }
  }
  return lines.join("\n");
}

/** One row per department: headcount, and the names of whoever leads it. The
 *  rank-and-file are the first thing a large org can afford to lose. */
function summaryRoster(departments: Department[], total: number): string {
  const lines = [heading(total, departments.length)];
  for (const department of departments) {
    const leaders = department.members.filter((member) => member.rank !== "employee");
    const named = leaders.length === 0 ? "" : ` — ${leaders.map((member) => member.name).join(", ")}`;
    lines.push(`  ${department.name} (${department.members.length})${named}`);
  }
  return lines.join("\n");
}

/**
 * The floor: a headcount and as many department names as fit, with the rest
 * counted rather than dropped silently — a model that reads a cut list as the
 * whole org answers "eight departments" for an org of thirty.
 *
 * This level always fits. The doctrine above it is fixed-size, so the heading
 * alone has room left over at any budget this cap could sensibly take.
 */
function countsRoster(departments: Department[], total: number, room: number): string {
  const head = heading(total, departments.length);
  let best = head;
  for (let shown = 1; shown <= departments.length; shown += 1) {
    const listed = departments.slice(0, shown).map((department) => department.name);
    const dropped = departments.length - shown;
    if (dropped > 0) listed.push(`+${dropped} more`);
    const line = `${head} ${listed.join(", ")}`;
    if (line.length > room) break;
    best = line;
  }
  return best;
}

/**
 * The standing brief for this instance, and how much of the org fitted in it.
 *
 * The registry is passed in rather than scanned here so the builder stays a
 * function of its inputs: the gateway hands it `orgRegistry(config)`.
 */
export function buildStandingBrief(
  config: Pick<JinnConfig, "portal">,
  registry: Map<string, Employee>,
): StandingBrief {
  const doctrine = [POSTURE, WHAT_JINN_IS, BLOCKS, identity(config)].join("\n\n");
  if (registry.size === 0) return { text: doctrine, rosterLevel: "empty" };

  const departments = departmentsOf(registry);
  const room = TALK_BRIEF_BUDGET_CHARS - doctrine.length - "\n\n".length;
  const withRoster = (roster: string, rosterLevel: RosterLevel): StandingBrief => ({
    text: `${doctrine}\n\n${roster}`,
    rosterLevel,
  });

  const full = fullRoster(departments, resolveOrgHierarchy(registry), registry.size);
  if (full.length <= room) return withRoster(full, "full");
  const summary = summaryRoster(departments, registry.size);
  if (summary.length <= room) return withRoster(summary, "summary");
  return withRoster(countsRoster(departments, registry.size, room), "counts");
}
