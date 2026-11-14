import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { OLD } from "../legacy-names.mjs"

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../legacy-names.mjs")
const adopt = (env) => execFileSync(process.execPath, [script, "adopt"], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" })

test("a variable under an old prefix is exported under the current one, quoted for the shell", () => {
  const out = adopt({ [`${OLD.upper}_PORT`]: "7790", [`${OLD.upper}_NOTE`]: "it's here" })
  assert.match(out, /^export HUNDREDFOLD_PORT='7790'$/m)
  assert.match(out, /^export HUNDREDFOLD_NOTE='it'\\''s here'$/m)
})

test("a variable that is already set under the current name is left as it is", () => {
  assert.doesNotMatch(adopt({ [`${OLD.upper}_PORT`]: "1", HUNDREDFOLD_PORT: "2" }), /HUNDREDFOLD_PORT/)
})

test("a name a shell cannot export is skipped, so the entrypoint's eval cannot fail on it", () => {
  assert.doesNotMatch(adopt({ [`${OLD.upper}_FOO-BAR`]: "1", [`${OLD.upper}_OK`]: "1" }), /FOO-BAR/)
})
