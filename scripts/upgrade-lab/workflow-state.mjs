import fs from "node:fs"
import path from "node:path"

const changed = (detail) => new Error(`Representative workflow state changed across the package swap${detail ? `: ${detail}` : ""}`)

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/** A candidate without a Workflow module can only leave the old data alone. */
function assertModulelessWorkflowPreserved(before, after) {
  if (before?.workflow?.count !== 1) throw changed("the baseline seeded no workflow")
  if (before.workflow.storage === "v2" && before.workflowsDb?.exists !== true) throw changed("the baseline left no workflows.db")
  if (!same(before.workflowsDb, after.workflowsDb)) throw changed("workflows.db was deleted or rewritten")
}

const sameWorkflow = (a, b) => a.id === b.id && a.title === b.title && a.sourceSha256 === b.sourceSha256

function assertImportedLegacyWorkflow(oldWorkflow, newWorkflow) {
  if (oldWorkflow?.count !== 1 || newWorkflow?.count !== 1) throw changed()
  if (!sameWorkflow(oldWorkflow, newWorkflow)) throw changed()
  if (newWorkflow.enabled !== false || newWorkflow.legacySourcePreserved !== true) throw changed()
  if (newWorkflow.importOutcome !== "imported") throw changed()
}

export function assertWorkflowStateSurvived(before, after) {
  const oldWorkflow = before?.workflow
  const newWorkflow = after?.workflow
  if (newWorkflow?.storage === "none") return assertModulelessWorkflowPreserved(before, after)
  if (oldWorkflow?.storage === "v2") {
    if (!same(oldWorkflow, newWorkflow)) throw changed()
    return
  }
  assertImportedLegacyWorkflow(oldWorkflow, newWorkflow)
}

export function assertWorkflowSkillRetired({ home, baselineTree, finalTree }) {
  try {
    fs.lstatSync(path.join(home, "skills", "workflow"))
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
  const inSkill = (key) => key === "skills/workflow" || key.startsWith("skills/workflow/")
  const keys = new Set([...Object.keys(baselineTree), ...Object.keys(finalTree)].filter(inSkill))
  const modified = [...keys].filter((key) => baselineTree[key] !== finalTree[key])
  if (modified.length > 0) {
    throw new Error(`skills/workflow is still present because its copy was modified after the baseline install (${modified.join(", ")}); the upgraded gateway keeps a modified skill only when the home has no .jinn-template-skills.json receipt, and with a receipt it retires the skill and backs it up, so this home either had no receipt or did not list the skill in it`)
  }
  throw new Error("skills/workflow is still present although it matches the baseline copy; the upgraded gateway should have retired it on first boot")
}
