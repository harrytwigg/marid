import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compareSemver, isStrictSemver } from "../../shared/version.js"

// The bundles committed under template/migrations, checked against the template
// they describe. The generator itself is covered by instance-migration-bundle.test.ts.

const packageRoot = path.resolve(".")
const templateRoot = path.join(packageRoot, "template")
const migrationsRoot = path.join(templateRoot, "migrations")

interface ManifestRecord {
  path: string
  operation: "add" | "modify" | "remove"
  baseSha256: string | null
  targetSha256: string | null
  basePayload: string | null
  targetPayload: string | null
}

interface Manifest {
  version: string
  baseVersion: string
  generatedFrom: { baseRef: string }
  files: ManifestRecord[]
}

function newestBundleVersion(): string {
  const versions = fs.readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isStrictSemver(entry.name))
    .map((entry) => entry.name)
    .sort(compareSemver)
  const newest = versions.at(-1)
  if (!newest) throw new Error("no migration bundles found")
  return newest
}

function readManifest(version: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(migrationsRoot, version, "manifest.json"), "utf8")) as Manifest
}

function sha(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("newest shipped migration bundle", () => {
  const version = newestBundleVersion()
  const manifest = readManifest(version)
  const remedy = "regenerate the newest bundle if it is unreleased, otherwise add one for the next version (release-jinn-cli step 4); generate refuses a released bundle"

  // An edit to a file the newest bundle lists shows up here as a stale target
  // hash. This needs no release tag, so it runs in every checkout; unlisted and
  // new template files are left to migration:check, which diffs the base release.
  it("targets the current template for every record it lists", () => {
    expect(manifest.version).toBe(version)
    for (const record of manifest.files) {
      const current = path.join(templateRoot, record.path)
      if (record.operation === "remove") {
        expect(fs.existsSync(current), `${record.path} still ships after bundle ${version}; ${remedy}`).toBe(false)
        continue
      }
      expect(fs.existsSync(current), `${record.path} is missing after bundle ${version}; ${remedy}`).toBe(true)
      expect(sha(fs.readFileSync(current)), `${record.path} changed after bundle ${version}; ${remedy}`)
        .toBe(record.targetSha256)
    }
  })

  it("carries payloads that match the manifest hashes", () => {
    for (const record of manifest.files) {
      for (const side of ["base", "target"] as const) {
        const payload = record[`${side}Payload`]
        const hash = record[`${side}Sha256`]
        if (payload === null) {
          expect(hash).toBeNull()
          continue
        }
        expect(sha(fs.readFileSync(path.join(migrationsRoot, version, payload)))).toBe(hash)
      }
    }
  })
})

describe("0.34.0 bundle: self-compaction doctrine", () => {
  const version = "0.34.0"
  const bundle = path.join(migrationsRoot, version)
  const heading = "## Long sessions: self-compaction"
  const record = readManifest(version).files.find((entry) => entry.path === "CLAUDE.md")

  function payload(side: "base" | "target"): string {
    const relative = record?.[`${side}Payload`]
    if (!relative) throw new Error(`CLAUDE.md has no ${side} payload`)
    return fs.readFileSync(path.join(bundle, relative), "utf8")
  }

  // An instance that wrote its own version of the section where the stock one
  // goes: a three-way merge must stop on the wording, not stack two sections.
  // A same-named section added somewhere else is invisible to a textual merge,
  // which is why the bundle's MIGRATION.md asks for a merge by heading.
  it("conflicts instead of duplicating a section the instance already added", () => {
    const base = payload("base")
    const anchor = "## Durable knowledge\n"
    expect(base).toContain(anchor)
    const instance = base.replace(
      anchor,
      `${heading}\n\nOur own note: compact with a handoff, then end the turn.\n\n${anchor}`,
    )

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-merge-"))
    temps.push(dir)
    for (const [name, text] of [["instance.md", instance], ["base.md", base], ["target.md", payload("target")]]) {
      fs.writeFileSync(path.join(dir, name), text)
    }
    const merged = spawnSync("git", ["merge-file", "-p", "instance.md", "base.md", "target.md"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })

    expect(merged.status).toBe(1)
    expect(merged.stdout.match(/^<<<<<<< /gm)).toHaveLength(1)
    expect(merged.stdout.split("\n").filter((line) => line === heading)).toHaveLength(1)
    expect(merged.stdout).toContain("Our own note")
  })
})
