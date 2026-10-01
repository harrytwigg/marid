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
