import fs from "node:fs"
import { syncTemplateSkills } from "../migrations/sync-template-skills.js"
import { JINN_HOME, TEMPLATE_DIR } from "../shared/paths.js"
import { getPackageVersion, isStrictSemver } from "../shared/version.js"

/** The gateway runs this on every boot, so `jinn migrate` exists only to do it on
 *  demand and say what moved. */
export async function runMigrate(): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) exitWith(`${JINN_HOME} does not exist. Run "jinn setup" first.`)
  const packageVersion = getPackageVersion()
  if (!isStrictSemver(packageVersion)) exitWith(`package version "${packageVersion}" is not a plain X.Y.Z release`)

  let result
  try {
    result = syncTemplateSkills({ instanceHome: JINN_HOME, templateDir: TEMPLATE_DIR, packageVersion })
  } catch (error) {
    exitWith(error instanceof Error ? error.message : String(error))
  }

  for (const name of result.added) console.log(`  added    ${name}`)
  for (const name of result.updated) console.log(`  updated  ${name}`)
  for (const name of result.removed) console.log(`  removed  ${name}`)
  if (result.added.length + result.updated.length + result.removed.length === 0) {
    console.log(`Already on ${packageVersion} — the skills Marid ships are up to date.`)
    return
  }
  console.log(`\nSynced the skills Marid ships to ${packageVersion}.`)
  if (result.backupDir) console.log(`Previous copies: ${result.backupDir}`)
}

function exitWith(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
  throw new Error("unreachable")
}
