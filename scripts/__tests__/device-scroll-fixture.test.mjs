import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { test } from "node:test"

import { assertDisposableHome, prepareSandbox, reachableAddresses } from "../device-scroll-fixture.mjs"

const disposable = path.join(os.tmpdir(), ".hundredfold-qa-flick")

const CONFIG = "gateway:\n  port: 7782\n"

/** The two shapes a mismatched native addon arrives in. */
const abiFailures = [
  () =>
    new Error(
      "The module '/repo/better_sqlite3.node' was compiled against a different Node.js version " +
        "using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 147.",
    ),
  () => Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" }),
]

/** @param {import("node:test").TestContext} t */
function sandboxHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-qa-flick-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, "config.yaml"), CONFIG)
  return home
}

/** @param {() => unknown} run */
function captureThrow(run) {
  try {
    run()
  } catch (error) {
    return /** @type {Error} */ (error)
  }
  return null
}

test("refuses the production instance home whatever port it carries", () => {
  const home = path.join(os.homedir(), ".hundredfold")
  assert.throws(() => assertDisposableHome(home, { gateway: { port: 7999 } }), /production instance home/)
})

test("refuses a home configured on the production or demo gateway port", () => {
  for (const port of [7777, 7788]) {
    assert.throws(
      () => assertDisposableHome(disposable, { gateway: { port } }),
      new RegExp(`port ${port}, which is a protected gateway`),
      `port ${port} should be refused`,
    )
  }
})

test("accepts a throwaway home on a free port, and one with no port yet", () => {
  assert.doesNotThrow(() => assertDisposableHome(disposable, { gateway: { port: 7782 } }))
  assert.doesNotThrow(() => assertDisposableHome(disposable, {}))
})

test("lists routable IPv4 addresses only, tailnet first", () => {
  const addresses = reachableAddresses({
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    utun3: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
  })
  assert.deepEqual(addresses, ["100.101.102.103", "192.168.1.20"])
})

test("only 100.64/10 counts as the tailnet; the rest of 100/8 stays behind the LAN", () => {
  const lan = { address: "192.168.1.20", family: "IPv4", internal: false }
  const publicLow = { address: "100.20.5.6", family: "IPv4", internal: false }
  const publicHigh = { address: "100.200.5.6", family: "IPv4", internal: false }
  const tailnet = { address: "100.101.102.103", family: "IPv4", internal: false }
  const expected = ["100.101.102.103", "192.168.1.20", "100.20.5.6", "100.200.5.6"]

  // Enumerated public-first, which is the order that exposes a rank the LAN shares
  // with public space: with the two tied, the sort leaves them as the machine
  // listed them and the phone is handed an address in AWS.
  assert.deepEqual(reachableAddresses({ en0: [publicLow], en1: [publicHigh], en2: [lan], utun3: [tailnet] }), expected)
  assert.deepEqual(reachableAddresses({ en0: [lan], en1: [publicLow], en2: [publicHigh], utun3: [tailnet] }), expected)
})

test("an ABI mismatch says which Node the addon needs and how to get it", (t) => {
  for (const makeFailure of abiFailures) {
    const error = captureThrow(() =>
      prepareSandbox(sandboxHome(t), () => {
        throw makeFailure()
      }),
    )
    assert.ok(error, "the mismatch should abort the run")
    // 24.13.0 is `.nvmrc`; the script reads it rather than repeating it.
    assert.match(error.message, /Node 24\.13\.0/)
    assert.match(error.message, /pnpm exec node scripts\/device-scroll-fixture\.mjs/)
  }
})

test("a store that will not open leaves config.yaml byte-identical", (t) => {
  for (const makeFailure of abiFailures) {
    const home = sandboxHome(t)
    const configPath = path.join(home, "config.yaml")
    const before = fs.readFileSync(configPath)
    captureThrow(() =>
      prepareSandbox(home, () => {
        throw makeFailure()
      }),
    )
    assert.deepEqual(fs.readFileSync(configPath), before, "no host rewrite, no portal flags")
  }
})

test("an open failure that is not an ABI mismatch is reported as itself", (t) => {
  const error = captureThrow(() =>
    prepareSandbox(sandboxHome(t), () => {
      throw new Error("SQLITE_CANTOPEN: unable to open database file")
    }),
  )
  assert.match(/** @type {Error} */ (error).message, /SQLITE_CANTOPEN/)
})
