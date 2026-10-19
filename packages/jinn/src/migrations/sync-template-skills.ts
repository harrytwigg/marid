import fs from "node:fs"
import path from "node:path"
import yaml from "js-yaml"
import {
  deriveTemplateMaterializationInputs,
  materializeTemplateBytes,
  type TemplateMaterializationInputs,
} from "../shared/template-materialization.js"
import { matchesReceiptlessRetiredSkill, receiptlessRetiredSkillNames } from "./receiptless-retired-skills.js"
import { stampVersionInYaml } from "./version-marker.js"
import { LEGACY_RECEIPT_FILE, RECEIPT_FILE } from "./receipt-names.js"

/** The names Jinn shipped the last time it synced. The template alone says which
 *  skills ship *now*, so without this record a retired skill and a skill the user
 *  wrote themselves look identical, and only one of them may be deleted. */
const BACKUP_ROOT = ".migration-backups"

export interface TemplateSkillSync {
  added: string[]
  updated: string[]
  removed: string[]
  backupDir: string | null
}

interface PlannedWrite {
  destination: string
  bytes: Buffer
}

/** A whole-file replacement decided during planning and written once the skills land. */
interface PlannedFile {
  destination: string
  text: string
  mode?: number
}

type BackupWriter = ReturnType<typeof backupWriter>

interface PlanContext {
  skillsRoot: string
  templateSkillsRoot: string
  inputs: TemplateMaterializationInputs
}

interface SyncPlan {
  writes: PlannedWrite[]
  deletions: string[]
  retiredDirs: string[]
  added: string[]
  updated: string[]
  removed: string[]
}

/**
 * Bring every skill Jinn ships back to the template, add the new ones, and drop the
 * retired ones. Anything the template does not ship — a skill the user wrote, `org/`,
 * `knowledge/`, `CLAUDE.md`, `config.yaml` values, `skills.json` — is left alone.
 *
 * The whole change is planned before a single byte is written, so a destination that
 * would escape `<home>/skills` aborts the run instead of half-applying it.
 */
export function syncTemplateSkills(options: {
  instanceHome: string
  templateDir: string
  packageVersion: string
}): TemplateSkillSync {
  const home = fs.realpathSync(options.instanceHome)
  const context: PlanContext = {
    skillsRoot: path.join(home, "skills"),
    templateSkillsRoot: path.join(options.templateDir, "skills"),
    inputs: deriveTemplateMaterializationInputs(readInstanceConfig(home)),
  }
  const shipped = listDirectories(context.templateSkillsRoot)

  const plan: SyncPlan = { writes: [], deletions: [], retiredDirs: [], added: [], updated: [], removed: [] }
  for (const name of shipped) planShippedSkill(plan, context, name)
  planRetiredSkills(plan, context, shipped, readReceipt(home))

  // The receipt and config.yaml are written last but decided first: a config.yaml that
  // cannot be stamped has to refuse before any skill is touched, not after.
  const receipt = plannedReceipt(home, options.packageVersion, shipped)
  const stamp = plannedVersionStamp(home, options.packageVersion)

  const backup = backupWriter(home, options.packageVersion)
  applyPlan(plan, backup)
  seedSkillsIndex(home, options.templateDir)
  if (receipt) writePlannedFile(receipt, backup)
  if (stamp) writePlannedFile(stamp, backup)

  return { added: plan.added, updated: plan.updated, removed: plan.removed, backupDir: backup.directory() }
}

function planShippedSkill(plan: SyncPlan, context: PlanContext, name: string): void {
  const templateSkillDir = path.join(context.templateSkillsRoot, name)
  const instanceSkillDir = resolveSkillPath(context.skillsRoot, name)
  const existed = fs.existsSync(instanceSkillDir)
  const shippedFiles = listFilesRecursive(templateSkillDir)
  let changed = false

  for (const relative of shippedFiles) {
    const write = plannedWrite(context, name, templateSkillDir, relative)
    if (!write) continue
    plan.writes.push(write)
    changed = true
  }

  const keep = new Set(shippedFiles)
  for (const relative of listFilesRecursive(instanceSkillDir)) {
    if (keep.has(relative)) continue
    plan.deletions.push(resolveSkillPath(context.skillsRoot, path.join(name, relative)))
    changed = true
  }

  if (!changed) return
  ;(existed ? plan.updated : plan.added).push(name)
}

/** Null when the instance already holds exactly these bytes as a regular file. */
function plannedWrite(context: PlanContext, name: string, templateSkillDir: string, relative: string): PlannedWrite | null {
  const source = path.join(templateSkillDir, relative)
  if (!fs.lstatSync(source).isFile()) throw new Error(`template skill "${name}" carries ${relative}, which is not a regular file`)
  const destination = resolveSkillPath(context.skillsRoot, path.join(name, relative))
  const bytes = materializeTemplateBytes(relative, fs.readFileSync(source), context.inputs)
  return isUpToDate(destination, bytes) ? null : { destination, bytes }
}

function planRetiredSkills(plan: SyncPlan, context: PlanContext, shipped: string[], previous: string[] | null): void {
  for (const name of previous ?? receiptlessRetiredSkillNames()) {
    if (shipped.includes(name)) continue
    const dir = resolveSkillPath(context.skillsRoot, name)
    if (!fs.existsSync(dir)) continue
    if (previous === null && !matchesReceiptlessRetiredSkill(dir, name, context.inputs)) continue
    // Unlink a symlinked skill dir rather than walking it: its target is not ours to delete.
    if (!fs.lstatSync(dir).isSymbolicLink()) {
      for (const relative of listFilesRecursive(dir)) plan.deletions.push(path.join(dir, relative))
    }
    plan.retiredDirs.push(dir)
    plan.removed.push(name)
  }
}

function applyPlan(plan: SyncPlan, backup: BackupWriter): void {
  const changing = new Set([...plan.deletions, ...plan.writes.map((write) => write.destination)])
  for (const destination of changing) backup.capture(destination)
  for (const destination of plan.deletions) {
    fs.rmSync(destination, { force: true })
  }
  for (const { destination, bytes } of plan.writes) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    // Never write through a link: the instance must own the file, not point at it.
    fs.rmSync(destination, { force: true })
    fs.writeFileSync(destination, bytes)
  }
  for (const dir of plan.retiredDirs) fs.rmSync(dir, { recursive: true, force: true })
}

/** Every write and every delete resolves through here, so a crafted skill name — from
 *  the template or from a receipt the user could have edited — cannot reach outside. */
function resolveSkillPath(skillsRoot: string, relative: string): string {
  const resolved = path.resolve(skillsRoot, relative)
  // Equality is a refusal, not a pass: a receipt naming "." would otherwise retire the
  // whole skills directory, user-authored skills included.
  if (resolved === skillsRoot || !resolved.startsWith(`${skillsRoot}${path.sep}`)) {
    throw new Error(`refusing "${relative}": it does not resolve to a path inside the skills directory`)
  }
  assertNoSymlinkedParent(skillsRoot, resolved)
  return resolved
}

/** A lexically contained path is not a contained path. If `skills/<name>` is a symlink,
 *  every write and unlink beneath it lands wherever it points, so a directory on the way
 *  down is refused outright. Only the leaf may be a link — that one is replaced, never
 *  followed. */
function assertNoSymlinkedParent(skillsRoot: string, resolved: string): void {
  for (let current = path.dirname(resolved); current !== skillsRoot; current = path.dirname(current)) {
    let stat: fs.Stats
    try { stat = fs.lstatSync(current) } catch { continue }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing "${path.relative(skillsRoot, resolved)}": "${path.relative(skillsRoot, current)}" is a symlink`)
    }
  }
}

function isUpToDate(destination: string, bytes: Buffer): boolean {
  let stat: fs.Stats
  try { stat = fs.lstatSync(destination) } catch { return false }
  // A symlink is replaced even when it happens to resolve to the right bytes.
  if (!stat.isFile()) return false
  return fs.readFileSync(destination).equals(bytes)
}

function listDirectories(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/** Paths relative to `dir`, symlinked directories deliberately not followed. */
function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const found: string[] = []
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push(path.relative(dir, full))
    }
  }
  walk(dir)
  return found.sort()
}

function backupWriter(home: string, packageVersion: string) {
  let directory: string | null = null
  return {
    directory: () => directory,
    /** Preserve what is visible at `destination` today. A symlink is read through
     *  on purpose: those are the bytes the path served before the sync. */
    capture(destination: string) {
      let bytes: Buffer
      try { bytes = fs.readFileSync(destination) } catch { return }
      if (!directory) {
        directory = path.join(home, BACKUP_ROOT, `${packageVersion}-${timestamp()}`)
        fs.mkdirSync(directory, { recursive: true })
      }
      const copy = path.join(directory, path.relative(home, destination))
      fs.mkdirSync(path.dirname(copy), { recursive: true })
      fs.writeFileSync(copy, bytes)
    },
  }
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-")

function readInstanceConfig(home: string): { portal?: { portalName?: string } } | null {
  const configPath = path.join(home, "config.yaml")
  if (!fs.existsSync(configPath)) return null
  let parsed: unknown
  try { parsed = yaml.load(fs.readFileSync(configPath, "utf8")) } catch (error) {
    throw new Error(`config.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parsed && typeof parsed === "object" ? parsed as { portal?: { portalName?: string } } : null
}

/** The template's index is empty; the instance's records what the user has installed.
 *  So it seeds a fresh instance and is never written over after that. */
function seedSkillsIndex(home: string, templateDir: string): void {
  const destination = path.join(home, "skills.json")
  const source = path.join(templateDir, "skills.json")
  if (fs.existsSync(destination) || !fs.existsSync(source)) return
  fs.writeFileSync(destination, fs.readFileSync(source))
}

/** No receipt is a first run. A receipt that exists but will not read is not: it is the
 *  record deciding what gets deleted, so it refuses rather than quietly reading as empty
 *  and then overwriting the only evidence of what went wrong. */
function readReceipt(home: string): string[] | null {
  const receiptPath = path.join(home, fs.existsSync(path.join(home, RECEIPT_FILE)) ? RECEIPT_FILE : LEGACY_RECEIPT_FILE)
  let raw: string
  try { raw = fs.readFileSync(receiptPath, "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error(`cannot read ${RECEIPT_FILE}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (error) {
    throw new Error(`${RECEIPT_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const skills = (parsed as { skills?: unknown } | null)?.skills
  if (!Array.isArray(skills) || skills.some((name) => typeof name !== "string")) {
    throw new Error(`${RECEIPT_FILE} needs a "skills" array of names`)
  }
  return skills as string[]
}

function plannedReceipt(home: string, version: string, skills: string[]): PlannedFile | null {
  const destination = path.join(home, RECEIPT_FILE)
  const text = JSON.stringify({ version, skills })
  if (fs.existsSync(destination) && fs.readFileSync(destination, "utf8") === text) return null
  return { destination, text }
}

function plannedVersionStamp(home: string, packageVersion: string): PlannedFile | null {
  const destination = path.join(home, "config.yaml")
  if (!fs.existsSync(destination)) return null
  const raw = fs.readFileSync(destination, "utf8")
  const result = stampVersionInYaml(raw, packageVersion)
  if (!result.ok) throw new Error(result.reason)
  if (result.text === raw) return null
  return { destination, text: result.text, mode: fs.statSync(destination).mode & 0o777 }
}

/** config.yaml is hot-reloaded by a running gateway, so both land by rename. */
function writePlannedFile(file: PlannedFile, backup: BackupWriter): void {
  backup.capture(file.destination)
  const temp = `${file.destination}.sync-${process.pid}.tmp`
  fs.writeFileSync(temp, file.text, file.mode === undefined ? {} : { mode: file.mode })
  fs.renameSync(temp, file.destination)
}
