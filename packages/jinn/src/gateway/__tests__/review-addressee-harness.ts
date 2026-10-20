import fs from "node:fs";
import path from "node:path";
import { as, call, context, home, sessionOf, startScopedHarness } from "./department-scope-harness.js";

/**
 * The parent-addressed review fixture: an open `engineering` department with
 * three employees, a parent Todo an employee owns and a child of it in review.
 *
 *   owner-dev:  owns the parent
 *   child-dev:  produces the child
 *   third-dev:  uninvolved
 */

export { as, call, context, home, sessionOf };

function writeEmployee(name: string): void {
  const file = path.join(home, "org", "engineering", `${name}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    `name: ${name}`, `displayName: ${name.replace("-dev", " Dev")}`, "department: engineering", "rank: employee", "engine: claude", "model: opus", "persona: Works on engineering.", "",
  ].join("\n"));
}

export async function startParentReviewHarness() {
  const modules = await startScopedHarness();
  const { refreshOrg } = await import("../org-registry.js");
  for (const name of ["owner-dev", "child-dev", "third-dev"]) writeEmployee(name);
  refreshOrg(context.getConfig());
  return { ...modules, refreshOrg };
}

/** A parent owned by `parentOwner` and an `in_review` child of it. */
export function treeInReview(
  workItems: Awaited<ReturnType<typeof startScopedHarness>>["workItems"],
  title: string,
  { parentOwner = "owner-dev", parentStatus = "executing" }: { parentOwner?: string; parentStatus?: "backlog" | "executing" | "in_review" } = {},
) {
  const parent = workItems.createWorkItem({ title: `${title} parent`, status: parentStatus, assignee: parentOwner });
  const child = workItems.createWorkItem({ title: `${title} child`, status: "in_review", parentId: parent.id, assignee: "child-dev" });
  return { parent, child };
}

export function statusPost(sessionId: string, id: string, body: Record<string, unknown>) {
  return as(sessionId)("POST", `/api/work-items/${id}/status`, body);
}
