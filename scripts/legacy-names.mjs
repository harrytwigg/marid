#!/usr/bin/env node
// The old names (the ones before the rename) for the scripts that have to protect or scrub an install still carrying
// them. The values are in one file, packages/hundredfold/src/shared/legacy-names.json; this reads it so no script spells them.
//
//   import { LEGACY, legacyEnv } from "./legacy-names.mjs"
//   node scripts/legacy-names.mjs unset HOME PORT   prints `unset <OLD>_HOME <OLD>_PORT ...` for a shell to eval
//   node scripts/legacy-names.mjs home-name         prints the old default home directory name
import fs from "node:fs"
import { fileURLToPath } from "node:url"

export const LEGACY = JSON.parse(fs.readFileSync(new URL("../packages/hundredfold/src/shared/legacy-names.json", import.meta.url), "utf8"))

/** `<OLD>_HOME` for each old prefix: `legacyEnv("HOME")`. */
export const legacyEnv = (suffix) => LEGACY.envPrefixes.map((prefix) => `${prefix}_${suffix}`)

/** The old name in each form a fixture needs, so a test of how an old install is read never spells it. */
export const OLD = {
  codename: LEGACY.codename,
  upper: LEGACY.codename.toUpperCase(),
  title: LEGACY.codename[0].toUpperCase() + LEGACY.codename.slice(1),
  portalName: LEGACY.portalName,
  productName: LEGACY.productName,
  package: LEGACY.package,
}

/** The old default home directory name (a dot, then the old codename). */
export const legacyHomeName = `.${LEGACY.codename}`

/** The old title-case name: macOS and Windows data directories use it. */
export const legacyTitle = LEGACY.codename[0].toUpperCase() + LEGACY.codename.slice(1)

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "unset") {
    const keys = process.argv.slice(3).flatMap((suffix) => legacyEnv(suffix))
    if (keys.length > 0) console.log(`unset ${keys.join(" ")}`)
  } else if (process.argv[2] === "home-name") {
    console.log(legacyHomeName)
  }
}
