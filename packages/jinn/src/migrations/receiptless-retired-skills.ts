import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { TemplateMaterializationInputs } from "../shared/template-materialization.js"

interface HashedBytes {
  bytes: number
  sha256: string
}

interface MaterializedBytes {
  input: keyof TemplateMaterializationInputs
}

type FingerprintPart = HashedBytes | MaterializedBytes
/** One shipped version of a file: a sequence of hashed and substituted parts. */
type FileVersion = readonly FingerprintPart[]
/** A file's fingerprint: one version, or `anyOf` several that shipped over time. */
type FileFingerprint = FileVersion | { anyOf: readonly FileVersion[] }
type SkillFingerprint = Record<string, FileFingerprint>

/**
 * Fingerprints preserve provenance without shipping a discoverable copy of retired
 * instructions. Static byte ranges are hashed; template substitutions are matched
 * exactly against the instance inputs that produced the installed skill.
 */
const RECEIPTLESS_RETIRED_SKILLS: Record<string, SkillFingerprint> = {
  experiments: {
    // 0.29.x shipped the first version of this file; 0.30.0 added todoId/owner.
    "SKILL.md": {
      anyOf: [
        [{ bytes: 1375, sha256: "f6080dc4b838eb6575da0fa06127f6d2f03e8557999f9834e8817fe25378d2ae" }],
        [{ bytes: 1620, sha256: "bdcac32428219bc08580ecfa26a4b3aaade3ac01c6741c8650018e973f6d57b5" }],
      ],
    },
  },
  migrate: {
    "SKILL.md": [
      { bytes: 90, sha256: "67cdaf6fb6891b4b50ff23fb9284e2f25a680c8a0c4c8e309040c97be6bfabe7" },
      { input: "portalName" },
      { bytes: 3746, sha256: "febb1f049c239ffa3e423be24184cc3a11fdbc75af6fd3da19e7e8ff9eebbe30" },
    ],
  },
  workflow: {
    // Every version of this file the template carried, oldest first. None has a
    // template substitution: its {{ ... }} spans are Workflow expressions.
    "SKILL.md": {
      anyOf: [
        [{ bytes: 5164, sha256: "9671f1a9df7bfb40eef3cd5f4169fda032302e801837119b49aaf584700967f7" }],
        [{ bytes: 5738, sha256: "f7d066afe0f85acff04dad79cd910deaa916c20981ee749a7516b104c691e617" }],
        [{ bytes: 6012, sha256: "3a1a853de652ae0d3f6bcf95d112300cdac187fe7ecf76537cf93c177a487d77" }],
        [{ bytes: 6486, sha256: "7b3d29f4863e494ce97fc76aa0511582aec84406fb674c2048a30662dba999fb" }],
        [{ bytes: 6248, sha256: "2eb90f82be297d6a48edab1ceb29a0d6e305d45f8cdd87e68026e15523d4062f" }],
        [{ bytes: 7716, sha256: "f5feaed210e3fe61b4471ae658525a665235c72f9e647bbc34f14b6e0f400ea8" }],
        [{ bytes: 2670, sha256: "08c19ee703407f67ea297dd3145b8dde91b64131a0c4b312c76781359960ad8e" }],
        [{ bytes: 3445, sha256: "a7ec13e7113d35cf1ded951c37cb14381d7d88f868cfcac8145b6e18d3ab7630" }],
        [{ bytes: 4878, sha256: "9da1cacc159cbabb74bb4fc36887eec2a096c1b140b703ba0fa0c2296f47a698" }],
        [{ bytes: 5216, sha256: "96817399ba4201cff7a1dfb02dc753c60025477c1cf85cd76fc8b92c4e0fe36c" }],
        [{ bytes: 5470, sha256: "88e344c4a33c635d4a3329a4617cb468bcad21c0da213f1b4f84c9e155e893a8" }],
        [{ bytes: 4700, sha256: "f0d6a41c74b10dda5f5cdc56450af0fb6fcc95b01350707d2e725a7663d97338" }],
        [{ bytes: 5028, sha256: "31415a0a5ada2b290c80992e3e1379a086057c3738974c70fae3a1f168b4f676" }],
        [{ bytes: 5429, sha256: "6631234ed590a341ebf7596ce72eb04e337306eb847da380282a428f1682d260" }],
        [{ bytes: 5622, sha256: "c7ee793fef5d842a9124bb0fbb769d44a8a1c33cc1d35459a18d24b38639860e" }],
        [{ bytes: 5544, sha256: "989c2868607833659077f38840589145bd897a91c6d5f44d44030f50c96d8a59" }],
        [{ bytes: 7376, sha256: "efacaf13a7766e3ff4fb5f50595f5cca71d9d492eb80fa6c9c336996cad6fcdd" }],
        [{ bytes: 8163, sha256: "32cb0c3a3c5358643825f6bf5c45973b9c751f108d05f7a8763c30f560cf3f58" }],
      ],
    },
  },
}

export function receiptlessRetiredSkillNames(): string[] {
  return Object.keys(RECEIPTLESS_RETIRED_SKILLS).sort()
}

export function matchesReceiptlessRetiredSkill(
  skillDir: string,
  name: string,
  inputs: TemplateMaterializationInputs,
): boolean {
  const fingerprint = RECEIPTLESS_RETIRED_SKILLS[name]
  if (!fingerprint || !isRegularDirectory(skillDir)) return false

  const actual = directoryShape(skillDir)
  if (!actual) return false
  const expectedFiles = Object.keys(fingerprint).sort()
  const expectedDirectories = parentDirectories(expectedFiles)
  if (!sameStrings(actual.files, expectedFiles) || !sameStrings(actual.directories, expectedDirectories)) return false

  return expectedFiles.every((relative) => matchesFile(
    path.join(skillDir, relative),
    fingerprint[relative],
    inputs,
  ))
}

function isRegularDirectory(candidate: string): boolean {
  try { return fs.lstatSync(candidate).isDirectory() } catch { return false }
}

function directoryShape(root: string): { files: string[]; directories: string[] } | null {
  const files: string[] = []
  const directories: string[] = []
  const walk = (current: string): boolean => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const relative = path.relative(root, full)
      if (entry.isDirectory()) {
        directories.push(relative)
        if (!walk(full)) return false
      } else if (entry.isFile()) {
        files.push(relative)
      } else {
        return false
      }
    }
    return true
  }
  return walk(root) ? { files: files.sort(), directories: directories.sort() } : null
}

function parentDirectories(files: string[]): string[] {
  const found = new Set<string>()
  for (const file of files) {
    for (let current = path.dirname(file); current !== "."; current = path.dirname(current)) found.add(current)
  }
  return [...found].sort()
}

function sameStrings(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function matchesFile(
  file: string,
  fingerprint: FileFingerprint,
  inputs: TemplateMaterializationInputs,
): boolean {
  const contents = fs.readFileSync(file)
  const versions = "anyOf" in fingerprint ? fingerprint.anyOf : [fingerprint]
  return versions.some((version) => matchesVersion(contents, version, inputs))
}

function matchesVersion(
  contents: Buffer,
  fingerprint: FileVersion,
  inputs: TemplateMaterializationInputs,
): boolean {
  let offset = 0
  for (const part of fingerprint) {
    if ("input" in part) {
      const expected = Buffer.from(inputs[part.input], "utf8")
      if (!contents.subarray(offset, offset + expected.length).equals(expected)) return false
      offset += expected.length
      continue
    }
    const slice = contents.subarray(offset, offset + part.bytes)
    if (slice.length !== part.bytes || sha256(slice) !== part.sha256) return false
    offset += part.bytes
  }
  return offset === contents.length
}

const sha256 = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex")
