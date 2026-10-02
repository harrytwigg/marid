#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const RATIONALE_START = "<!-- BEGIN RELEASE RATIONALE -->"
const RATIONALE_END = "<!-- END RELEASE RATIONALE -->"

function fail(message) {
  process.stderr.write(`instance migration bundle: ${message}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const [mode, ...rest] = argv
  if (mode !== "generate" && mode !== "check") throw new Error("first argument must be generate or check")
  const values = { mode, allowEmpty: false, allowUnreleased: false, baseRef: "", version: "" }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--") continue
    if (arg === "--allow-empty") values.allowEmpty = true
    else if (arg === "--allow-unreleased") values.allowUnreleased = true
    else if (arg === "--base-ref") values.baseRef = rest[++i]
    else if (arg === "--version") values.version = rest[++i]
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!values.baseRef || !values.version) throw new Error("--base-ref and --version are required")
  if (!/^v?\d+\.\d+\.\d+$/.test(values.baseRef)) throw new Error("--base-ref must name a plain release tag/ref")
  if (!/^\d+\.\d+\.\d+$/.test(values.version)) throw new Error("--version must be X.Y.Z")
  return values
}

function isNewerVersion(candidate, current) {
  const candidateParts = candidate.split(".").map(Number)
  const currentParts = current.split(".").map(Number)
  for (let i = 0; i < candidateParts.length; i++) {
    if (candidateParts[i] !== currentParts[i]) return candidateParts[i] > currentParts[i]
  }
  return false
}

function roots() {
  const cwd = fs.realpathSync(process.cwd())
  const nested = path.join(cwd, "packages", "jinn")
  if (fs.existsSync(path.join(nested, "template"))) return { repoRoot: cwd, packageRoot: nested }
  if (fs.existsSync(path.join(cwd, "template"))) return { repoRoot: path.resolve(cwd, "../.."), packageRoot: cwd }
  throw new Error("run from the repository root or packages/jinn")
}

/** @param {BufferEncoding} encoding */
function git(repoRoot, args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: repoRoot, encoding })
}

/** A lookup that is expected to miss, so git's complaint must not reach the terminal. */
function gitQuiet(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

/**
 * Whether bundle `version` has shipped from this line of history. A same-named tag
 * HEAD cannot reach (an upstream release fetched into a fork, say) is not ours.
 */
function isReleased(repoRoot, version) {
  try {
    gitQuiet(repoRoot, ["merge-base", "--is-ancestor", `refs/tags/v${version}`, "HEAD"])
    return true
  } catch {
    return false
  }
}

function sha(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

function safeRelative(value) {
  const normalized = value.split(path.sep).join("/")
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || normalized.split("/").includes("..")) {
    throw new Error(`unsafe instance path: ${value}`)
  }
  return normalized
}

function targetBytes(templateRoot, relative) {
  const file = path.join(templateRoot, relative)
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink()) {
    throw new Error(`changed template symlink ${relative} is unsupported; replace it with a regular file or add manifest link metadata support`)
  }
  if (!stat.isFile()) throw new Error(`changed instance path is not a file: ${relative}`)
  return fs.readFileSync(file)
}

function baseBytes(repoRoot, baseRef, repoRelative) {
  return git(repoRoot, ["show", `${baseRef}:${repoRelative}`], null)
}

function validateBaseFileType(repoRoot, baseRef, templateRepoPath, relative) {
  const repoRelative = `${templateRepoPath}/${relative}`
  const line = git(repoRoot, ["ls-tree", baseRef, "--", repoRelative]).trim()
  if (!line.startsWith("120000 ")) return
  throw new Error(`changed template symlink ${relative} is unsupported in ${baseRef}; replace it with a regular file or add manifest link metadata support`)
}

function changedFiles(repoRoot, templateRepoPath, baseRef) {
  const raw = git(repoRoot, [
    "diff", "--name-status", "-z", "--no-renames", baseRef, "--",
    templateRepoPath,
    `:(exclude)${templateRepoPath}/migrations/**`,
  ])
  const fields = raw.split("\0").filter(Boolean)
  if (fields.length % 2 !== 0) throw new Error("unexpected git diff output")
  const result = []
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]
    const repoPath = fields[i + 1]
    if (!/^[AMD]$/.test(status)) throw new Error(`unsupported git diff status ${status}`)
    const relative = safeRelative(path.posix.relative(templateRepoPath, repoPath))
    result.push({ relative, operation: status === "A" ? "add" : status === "D" ? "remove" : "modify" })
  }
  const untracked = git(repoRoot, [
    "ls-files", "--others", "--exclude-standard", "-z", "--",
    templateRepoPath,
    `:(exclude)${templateRepoPath}/migrations/**`,
  ]).split("\0").filter(Boolean)
  for (const repoPath of untracked) {
    const relative = safeRelative(path.posix.relative(templateRepoPath, repoPath))
    if (!result.some((entry) => entry.relative === relative)) result.push({ relative, operation: "add" })
  }
  return result.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)
}

const DEFAULT_RATIONALE = "This release bundle was generated from the exact instance-template delta."
const UNRESOLVED_RELEASE_PLACEHOLDER = /\b(?:TODO|TBD|ACTION REQUIRED)\b|\bv?X\.Y\.Z\b|<version>/

function assertReleaseReadyRationale(rationale) {
  if (UNRESOLVED_RELEASE_PLACEHOLDER.test(rationale)) {
    throw new Error("unresolved release placeholder in preserved migration rationale")
  }
}

function rationaleFromSource(source, fallback = "") {
  const start = source.indexOf(RATIONALE_START)
  const end = source.indexOf(RATIONALE_END)
  if (start < 0 || end < start) return source.trim() || fallback
  return source.slice(start + RATIONALE_START.length, end).trim() || fallback
}

function readRationale(outputDir, committedFallback) {
  const file = path.join(outputDir, "MIGRATION.md")
  const committedRationale = rationaleFromSource(committedFallback)
  if (!fs.existsSync(file)) return committedRationale || DEFAULT_RATIONALE
  const source = fs.readFileSync(file, "utf8")
  const current = rationaleFromSource(source, committedRationale || DEFAULT_RATIONALE)
  return current === DEFAULT_RATIONALE && committedRationale ? committedRationale : current
}

function markdown(manifest, rationale) {
  const lines = [
    `# Instance migration bundle: ${manifest.baseVersion} → ${manifest.version}`,
    "",
    RATIONALE_START,
    rationale,
    RATIONALE_END,
    "",
    "This file is generated. The manifest is authoritative; each record below appears exactly once.",
    "Each record names only inputs that ship in this bundle or exist in the instance: the base payload under `files/base/` is the generic template before this release, the target payload under `files/target/` is the template after it, both relative to this bundle directory, and the current user-owned file is the instance path shown on the record.",
    "Materialize those payloads before comparing: in `.md`, `.yaml` and `.yml` files replace `{{portalName}}` with the instance's `portal.portalName` from `config.yaml` (default `Jinn`) and `{{portalSlug}}` with that name lowercased with runs of whitespace replaced by single hyphens, and leave every other file byte-for-byte unchanged.",
    "Then three-way merge the materialized base, the current instance file and the materialized target; preserve user customizations, record unresolved placeholders as conflicts, and never delete user content without explicit review and a snapshot.",
    "Merge Markdown by heading. When the target adds a section whose heading the instance file already has, reconcile it into that existing section and record a conflict where the wording differs; never append a second section with the same heading.",
    "",
  ]
  for (const entry of manifest.files) {
    lines.push(
      `## \`${entry.path}\``,
      "",
      `- Operation: \`${entry.operation}\``,
      `- Base payload: ${entry.basePayload ? `\`${entry.basePayload}\`` : "none (file did not exist)"}`,
      `- Target payload: ${entry.targetPayload ? `\`${entry.targetPayload}\`` : "none (file is removed from stock)"}`,
      `- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path \`${entry.path}\` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.`,
      "",
    )
  }
  return `${lines.join("\n").trimEnd()}\n`
}

function createBundle({ repoRoot, packageRoot, baseRef, version, outputDir, rationale, allowEmpty }) {
  const templateRoot = path.join(packageRoot, "template")
  const templateRepoPath = path.posix.relative(repoRoot.split(path.sep).join("/"), templateRoot.split(path.sep).join("/"))
  const changes = changedFiles(repoRoot, templateRepoPath, baseRef)
  if (changes.length === 0 && !allowEmpty) throw new Error("no instance-surface changes; pass --allow-empty to acknowledge")
  const manifest = {
    schemaVersion: 1,
    version,
    baseVersion: baseRef.replace(/^v/, ""),
    generatedFrom: { baseRef, headRef: "WORKTREE" },
    files: [],
  }
  fs.mkdirSync(outputDir, { recursive: true })
  for (const change of changes) {
    const repoRelative = `${templateRepoPath}/${change.relative}`
    if (change.operation !== "add") validateBaseFileType(repoRoot, baseRef, templateRepoPath, change.relative)
    const base = change.operation === "add" ? null : baseBytes(repoRoot, baseRef, repoRelative)
    const target = change.operation === "remove" ? null : targetBytes(templateRoot, change.relative)
    const basePayload = base ? `files/base/${change.relative}` : null
    const targetPayload = target ? `files/target/${change.relative}` : null
    if (basePayload) {
      const destination = path.join(outputDir, basePayload)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, base)
    }
    if (targetPayload) {
      const destination = path.join(outputDir, targetPayload)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, target)
    }
    manifest.files.push({
      path: change.relative,
      operation: change.operation,
      baseSha256: base ? sha(base) : null,
      targetSha256: target ? sha(target) : null,
      basePayload,
      targetPayload,
    })
  }
  fs.writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(path.join(outputDir, "MIGRATION.md"), markdown(manifest, rationale))
}

function listFiles(root) {
  if (!fs.existsSync(root)) return []
  const result = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else result.push(path.relative(root, file).split(path.sep).join("/"))
    }
  }
  visit(root)
  return result
}

function equalDirectories(a, b) {
  const af = listFiles(a)
  const bf = listFiles(b)
  return JSON.stringify(af) === JSON.stringify(bf) && af.every((file) => fs.readFileSync(path.join(a, file)).equals(fs.readFileSync(path.join(b, file))))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const { repoRoot, packageRoot } = roots()
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))
  if (pkg.version !== args.version && (!args.allowUnreleased || !isNewerVersion(args.version, pkg.version))) throw new Error(`package version ${pkg.version} does not match requested bundle ${args.version}`)
  if (args.mode === "generate" && isReleased(repoRoot, args.version)) {
    throw new Error(`bundle ${args.version} was released as v${args.version}; add a bundle for the next version instead of regenerating it`)
  }
  git(repoRoot, ["rev-parse", "--verify", `${args.baseRef}^{commit}`])
  const outputDir = path.join(packageRoot, "template", "migrations", args.version)
  let committedFallback = ""
  try {
    const repoPath = path.relative(repoRoot, path.join(outputDir, "MIGRATION.md")).split(path.sep).join("/")
    committedFallback = gitQuiet(repoRoot, ["show", `HEAD:${repoPath}`]).trim()
  } catch { /* a new migration has no committed rationale yet */ }
  const rationale = readRationale(outputDir, committedFallback)
  assertReleaseReadyRationale(rationale)
  if (args.mode === "generate") {
    fs.rmSync(outputDir, { recursive: true, force: true })
    createBundle({ repoRoot, packageRoot, outputDir, rationale, ...args })
    process.stdout.write(`generated ${path.relative(repoRoot, outputDir)}\n`)
    return
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-migration-check-"))
  try {
    createBundle({ repoRoot, packageRoot, outputDir: temp, rationale, ...args, allowEmpty: true })
    if (!equalDirectories(outputDir, temp)) {
      throw new Error(isReleased(repoRoot, args.version)
        ? `bundle ${args.version} is out of date, but it was released as v${args.version}; add a bundle for the next version`
        : `bundle ${args.version} is out of date; run migration:generate`)
    }
    process.stdout.write(`migration bundle ${args.version} is current\n`)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

try { main() } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
