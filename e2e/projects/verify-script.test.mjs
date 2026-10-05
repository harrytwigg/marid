import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

const script = fs.readFileSync(path.resolve("scripts/verify-projects.sh"), "utf8")

const UNSET = /^unset (JINN_(?:[A-Z_]+ )*JINN_[A-Z_]+)$/m

/**
 * A Jinn session exports JINN_HOME, JINN_PORT, JINN_INSTANCE and friends pointing at the
 * operator's live gateway. resolveJinnHome() honours JINN_HOME over HOME and
 * applyGatewayEnvOverrides() honours JINN_PORT over the sandbox's own config.yaml, so an
 * inherited environment aims create/start/stop/destroy at production. The verifier only
 * escaped that by typing `env -u ...` from memory; the script has to do it itself.
 */
test("verification scrubs the caller's instance out of the environment", () => {
  const unset = script.match(UNSET)
  assert.ok(unset, "expected a top-level `unset JINN_...` line")
  const scrubbed = new Set(unset[1].split(" "))
  for (const key of [
    "JINN_HOME",
    "JINN_PORT",
    "JINN_HOST",
    "JINN_INSTANCE",
    "JINN_GATEWAY_URL",
    "JINN_GATEWAY_TOKEN",
    "JINN_SESSION_ID",
  ]) {
    assert.ok(scrubbed.has(key), `expected ${key} to be unset`)
  }
})

test("the scrub lands before the sandbox is resolved, seeded or created", () => {
  const scrub = script.indexOf("\nunset JINN_")
  assert.ok(scrub >= 0, "expected a top-level `unset JINN_...` line")
  assert.ok(scrub < script.indexOf('HELPER="'), "scrub must precede helper resolution")
  assert.ok(scrub < script.indexOf('PORT="'), "scrub must precede port resolution")
  assert.ok(scrub < script.indexOf('"$HELPER" create'), "scrub must precede sandbox create")
})

/** JINN_VERIFY_* are this script's own inputs, and JINN_REPO is what it hands the helper. */
test("the scrub keeps the script's own knobs", () => {
  const scrubbed = new Set((script.match(UNSET)?.[1] ?? "").split(" "))
  for (const key of scrubbed) {
    assert.ok(!key.startsWith("JINN_VERIFY_"), `${key} is an input to this script, not a leak`)
  }
  assert.ok(!scrubbed.has("JINN_REPO"))
  assert.ok(!scrubbed.has("JINN_SANDBOX_HELPER"))
  assert.match(script, /PORT="\$\{JINN_VERIFY_PORT:-8060\}"/)
  assert.match(script, /JINN_REPO="\$REPO"/)
})

/**
 * The other half of the scrub: prove the sandbox is bound by its own config.yaml. If an
 * inherited JINN_PORT ever slipped past the unset, applyGatewayEnvOverrides() would rebind the
 * gateway away from $PORT, and the run would be aimed at whatever that named.
 */
test("the sandbox's own configured port is asserted before the daemon starts", () => {
  const assertion = script.indexOf("CONFIGURED_PORT")
  assert.ok(assertion >= 0, "expected the config.yaml port to be read")
  assert.match(script, /if \[\[ "\$CONFIGURED_PORT" != "\$PORT" \]\]/)
  assert.ok(assertion < script.indexOf('"$HELPER" start'), "must precede sandbox start")
})

test("the sandbox port stays out of the operator's range", () => {
  assert.match(script, /PORT < 8060/)
  assert.match(script, /"7777" \|\| "\$PORT" == "7788"/)
})
