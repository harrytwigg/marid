import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { isBinary, mapWord, renamePath, renameText } from "../rename-codename/engine.mjs"
import { FROZEN_SUBTREES, KEEP_PATTERNS, keepContent, keepPatternsFor } from "../rename-codename/rules.mjs"
import { OLD } from "../legacy-names.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("the word map keeps the case of what it replaces, for both old names", () => {
  assert.equal(mapWord(OLD.codename), "hundredfold")
  assert.equal(mapWord(OLD.title), "Hundredfold")
  assert.equal(mapWord(OLD.upper), "HUNDREDFOLD")
  assert.equal(mapWord(OLD.productName.toLowerCase()), "hundredfold")
  assert.equal(mapWord(OLD.productName), "Hundredfold")
  assert.throws(() => mapWord(OLD.codename[0] + OLD.codename[1].toUpperCase() + OLD.codename.slice(2)), /no case mapping/)
})

test("an identifier, an environment variable and a path all follow the name", () => {
  const { text, changed } = renameText(`import { resolve${OLD.title}Home } from './home'; const x = process.env.${OLD.upper}_HOME + '/.${OLD.codename}-x'`, KEEP_PATTERNS)
  assert.equal(changed, true)
  assert.equal(text, "import { resolveHundredfoldHome } from './home'; const x = process.env.HUNDREDFOLD_HOME + '/.hundredfold-x'")
})

test("the attribution is left as it is, and the rest of the line is not", () => {
  const line = `Hundredfold is a fork of [${OLD.title}](https://github.com/hristo2612/${OLD.codename}) by hristo2612; Copyright (c) 2026 ${OLD.title} Contributors; the ${OLD.codename} app`
  const { text } = renameText(line, KEEP_PATTERNS)
  assert.equal(text, `Hundredfold is a fork of [${OLD.title}](https://github.com/hristo2612/${OLD.codename}) by hristo2612; Copyright (c) 2026 ${OLD.title} Contributors; the hundredfold app`)
})

test("everything else is renamed: bundle ids, schemes, database function names and volume names", () => {
  const line = `run.${OLD.codename}.shell ${OLD.codename}:// ${OLD.codename}_callback_identity ${OLD.codename}-home /home/node/.${OLD.codename} __${OLD.codename}_service_start__`
  assert.equal(renameText(line, KEEP_PATTERNS).text, "run.hundredfold.shell hundredfold:// hundredfold_callback_identity hundredfold-home /home/node/.hundredfold __hundredfold_service_start__")
})

test("the old package name becomes the new one, not a name with a suffix", () => {
  assert.equal(renameText(`npm i -g ${OLD.package} && ${OLD.codename} start`, KEEP_PATTERNS).text, "npm i -g hundredfold && hundredfold start")
  assert.equal(renamePath(`.claude/skills/release-${OLD.codename}-cli/SKILL.md`, FROZEN_SUBTREES), ".claude/skills/release-hundredfold/SKILL.md")
})

test("a path moves with the package, and what a released bundle holds does not", () => {
  assert.equal(renamePath(`packages/${OLD.codename}/src/shared/home.ts`, FROZEN_SUBTREES), "packages/hundredfold/src/shared/home.ts")
  assert.equal(renamePath(`packages/${OLD.codename}/bin/${OLD.codename}.ts`, FROZEN_SUBTREES), "packages/hundredfold/bin/hundredfold.ts")
  assert.equal(
    renamePath(`packages/hundredfold/template/migrations/0.30.0/files/base/skills/${OLD.codename}-sandbox/SKILL.md`, FROZEN_SUBTREES),
    `packages/hundredfold/template/migrations/0.30.0/files/base/skills/${OLD.codename}-sandbox/SKILL.md`,
  )
  assert.equal(renamePath(`packages/shell/src-tauri/gen/apple/${OLD.codename}-shell.xcodeproj/x`, FROZEN_SUBTREES), "packages/shell/src-tauri/gen/apple/hundredfold-shell.xcodeproj/x")
})

test("the repository has nothing left to rename outside the allowed places", () => {
  const out = execFileSync("node", ["scripts/rename-codename.mjs", "--check"], { cwd: root, encoding: "utf8" })
  assert.match(out, /clean/)
})

test("the credit, the forwarder line and the portal default are kept only in the files that carry them", () => {
  const credit = `fork of [${OLD.title}](https://github.com/hristo2612/${OLD.codename})`
  assert.equal(renameText(credit, keepPatternsFor("README.md")).text, credit)
  assert.equal(renameText(credit, keepPatternsFor("NOTICE")).text, credit)
  assert.match(renameText(credit, keepPatternsFor("packages/web/src/x.ts")).text, /^fork of \[Hundredfold\]/)
  const bin = `"${OLD.codename}": "./dist/bin/legacy-forwarder.js"`
  assert.equal(renameText(bin, keepPatternsFor("packages/hundredfold/package.json")).text, bin)
  assert.match(renameText(bin, keepPatternsFor("packages/web/package.json")).text, /"hundredfold"/)
})

test("a bundle of a released version is kept whole, and the bundle being built only in its base payload", () => {
  assert.equal(keepContent("packages/hundredfold/template/migrations/0.33.3/MIGRATION.md"), true)
  assert.equal(keepContent("packages/hundredfold/template/migrations/0.2.0/files/target/CLAUDE.md"), true)
  assert.equal(keepContent("packages/hundredfold/template/migrations/0.34.0/files/base/CLAUDE.md"), true)
  assert.equal(keepContent("packages/hundredfold/template/migrations/0.34.0/MIGRATION.md"), false)
  assert.equal(keepContent("packages/hundredfold/template/migrations/0.34.0/files/target/CLAUDE.md"), false)
  assert.equal(keepContent("packages/web/src/shared/legacy/names.json"), false)
})

test("only files that are not text are skipped, whatever bytes a text file holds", () => {
  assert.equal(isBinary(Buffer.from("x\u0000y"), "docs/note.md"), false)
  assert.equal(isBinary(Buffer.from("x"), "assets/shot.png"), true)
})
