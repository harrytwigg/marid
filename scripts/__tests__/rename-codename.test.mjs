import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { mapWord, renamePath, renameText } from "../rename-codename/engine.mjs"
import { FROZEN_SUBTREES, KEEP_PATTERNS } from "../rename-codename/rules.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("the word map keeps the case of what it replaces, for both old names", () => {
  assert.equal(mapWord("jinn"), "hundredfold")
  assert.equal(mapWord("Jinn"), "Hundredfold")
  assert.equal(mapWord("JINN"), "HUNDREDFOLD")
  assert.equal(mapWord("marid"), "hundredfold")
  assert.equal(mapWord("Marid"), "Hundredfold")
  assert.throws(() => mapWord("jInn"), /no case mapping/)
})

test("an identifier, an environment variable and a path all follow the name", () => {
  const { text, changed } = renameText("import { resolveJinnHome } from './home'; const x = process.env.JINN_HOME + '/.jinn-x'", KEEP_PATTERNS)
  assert.equal(changed, true)
  assert.equal(text, "import { resolveHundredfoldHome } from './home'; const x = process.env.HUNDREDFOLD_HOME + '/.hundredfold-x'")
})

test("the attribution, the upstream links and the app identity are left as they are, and the rest of the line is not", () => {
  const line = "Hundredfold is a fork of [Jinn](https://github.com/hristo2612/jinn) by hristo2612; open jinn:// links in run.jinn.shell and the jinn app"
  const { text } = renameText(line, KEEP_PATTERNS)
  assert.equal(text, "Hundredfold is a fork of [Jinn](https://github.com/hristo2612/jinn) by hristo2612; open jinn:// links in run.jinn.shell and the hundredfold app")
})

test("names a database schema refers to are kept", () => {
  const { text } = renameText("CHECK (x = jinn_callback_identity(x)) AND jinn_work_item_claim_digest(y) AND jinn_other", KEEP_PATTERNS)
  assert.equal(text, "CHECK (x = jinn_callback_identity(x)) AND jinn_work_item_claim_digest(y) AND hundredfold_other")
})

test("a docker volume is kept, a flag or a path that merely contains its name is not", () => {
  assert.equal(renameText("- jinn-home:/home/node/.jinn", KEEP_PATTERNS).text, "- jinn-home:/home/node/.jinn")
  assert.equal(renameText("--jinn-home /mnt/jinn-home jinn-home-x", KEEP_PATTERNS).text, "--hundredfold-home /mnt/hundredfold-home hundredfold-home-x")
})

test("a marked line, and a marked block, are kept whole", () => {
  const source = ["a jinn", "b jinn // rename:keep", "# rename:keep-begin", "c jinn", "d jinn", "# rename:keep-end", "e jinn"].join("\n")
  assert.equal(renameText(source, KEEP_PATTERNS).text, ["a hundredfold", "b jinn // rename:keep", "# rename:keep-begin", "c jinn", "d jinn", "# rename:keep-end", "e hundredfold"].join("\n"))
})

test("the old package name becomes the new one, not a name with a suffix", () => {
  assert.equal(renameText("npm i -g jinn-cli && jinn start", KEEP_PATTERNS).text, "npm i -g hundredfold && hundredfold start")
  assert.equal(renamePath(".claude/skills/release-jinn-cli/SKILL.md", FROZEN_SUBTREES), ".claude/skills/release-hundredfold/SKILL.md")
})

test("a path moves with the package, and what a released bundle holds does not", () => {
  assert.equal(renamePath("packages/jinn/src/shared/home.ts", FROZEN_SUBTREES), "packages/hundredfold/src/shared/home.ts")
  assert.equal(renamePath("packages/jinn/bin/jinn.ts", FROZEN_SUBTREES), "packages/hundredfold/bin/hundredfold.ts")
  assert.equal(
    renamePath("packages/jinn/template/migrations/0.30.0/files/base/skills/jinn-sandbox/SKILL.md", FROZEN_SUBTREES),
    "packages/hundredfold/template/migrations/0.30.0/files/base/skills/jinn-sandbox/SKILL.md",
  )
  assert.equal(renamePath("packages/shell/src-tauri/gen/apple/jinn-shell.xcodeproj/x", FROZEN_SUBTREES), "packages/shell/src-tauri/gen/apple/jinn-shell.xcodeproj/x")
})

test("the repository has nothing left to rename outside the allowed places", () => {
  const out = execFileSync("node", ["scripts/rename-codename.mjs", "--check"], { cwd: root, encoding: "utf8" })
  assert.match(out, /clean/)
})
