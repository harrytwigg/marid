import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import * as upgradeLab from "../run.mjs"

// A removal in a migration bundle is service-owned: completeInstanceMigration runs
// reconcileServiceOwnedRemovals itself and refuses a generic receipt that names a
// removal path. These lock the lab's merge to that contract.

test("materialized merge leaves a removal to the service and never claims it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-service-removal-"))
  try {
    const bundle = path.join(root, "materialized", "0.29.1")
    fs.mkdirSync(path.join(bundle, "files/base"), { recursive: true })
    fs.writeFileSync(path.join(bundle, "files/base/card-reference.md"), "retired\n")
    fs.mkdirSync(path.join(root, "talk"), { recursive: true })
    fs.writeFileSync(path.join(root, "talk", "card-reference.md"), "retired\n")
    const manifest = { files: [{ path: "talk/card-reference.md", operation: "remove", basePayload: "files/base/card-reference.md" }] }
    const audit = { files: [{ version: "0.29.1", path: "talk/card-reference.md", base: { unresolvedPlaceholders: [] }, target: { unresolvedPlaceholders: [] } }] }

    const receipt = upgradeLab.mergeBundle(root, bundle, manifest, audit, "0.29.1")

    // completeInstanceMigration refuses a receipt that names a removal path.
    assert.deepEqual(receipt.reviewedFiles, [])
    assert.deepEqual(receipt.skippedItems, [])
    assert.deepEqual(receipt.serviceOwnedRemovals, ["talk/card-reference.md"])
    // The service performs the removal at completion, so the merge leaves the file alone.
    assert.ok(fs.existsSync(path.join(root, "talk", "card-reference.md")))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("service-owned removals are proven gone after completion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-removal-assert-"))
  try {
    fs.mkdirSync(path.join(root, "talk"), { recursive: true })
    assert.doesNotThrow(() => upgradeLab.assertServiceOwnedRemovalsApplied({
      home: root,
      serviceOwnedRemovals: ["talk/card-reference.md"],
    }))

    fs.writeFileSync(path.join(root, "talk", "card-reference.md"), "still here\n")
    assert.throws(() => upgradeLab.assertServiceOwnedRemovalsApplied({
      home: root,
      serviceOwnedRemovals: ["talk/card-reference.md"],
    }), /survived completion/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
