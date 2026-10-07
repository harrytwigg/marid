import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { resolveJinnHome } from "../shared/paths.js";
import { skillRefusal } from "../shared/skill-inspection.js";
import { DEPARTMENT_SCOPES, INSTRUCTION_MODES, parseDepartmentYaml } from "./department-definition.js";
import { departmentWorkdirOptions } from "./department-workdirs.js";
import type { DepartmentScope } from "../work-items/department-scope.js";

/**
 * Writes a department's `department.yaml` for `PATCH /api/departments/:slug`
 * (FR-042). Hand-edited YAML stays the source of truth: the write merges the changed
 * fields into whatever the file already holds, keeps keys it does not know, and
 * replaces the file atomically (a temp file in the same directory, then a rename).
 * Comments in the file are not kept.
 */

export class DepartmentWriteError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "DepartmentWriteError";
  }
}

export interface DepartmentPatch {
  scope?: DepartmentScope;
  /** `null` removes the key. */
  displayName?: string | null;
  description?: string | null;
  workdirs?: string[];
  skills?: string[];
  mcp?: string[];
  sharedNotes?: string[];
  instructions?: (typeof INSTRUCTION_MODES)[number];
}

const TEXT_FIELDS = ["displayName", "description"] as const;
const LIST_FIELDS = ["workdirs", "skills", "mcp", "sharedNotes"] as const;

function invalid(message: string): never {
  throw new DepartmentWriteError("invalid", message);
}

function readScopeField(body: Record<string, unknown>, patch: DepartmentPatch): void {
  if (body.scope === undefined) return;
  if (typeof body.scope !== "string" || !(DEPARTMENT_SCOPES as readonly string[]).includes(body.scope)) invalid("scope must be open, scoped or dedicated");
  patch.scope = body.scope as DepartmentScope;
}

function readInstructionsField(body: Record<string, unknown>, patch: DepartmentPatch): void {
  if (body.instructions === undefined) return;
  if (!(INSTRUCTION_MODES as readonly unknown[]).includes(body.instructions)) invalid("instructions must be department or department+company");
  patch.instructions = body.instructions as (typeof INSTRUCTION_MODES)[number];
}

function readTextFields(body: Record<string, unknown>, patch: DepartmentPatch): void {
  for (const field of TEXT_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") invalid(`${field} must be text, or null to remove it`);
    patch[field] = typeof value === "string" && value.trim() ? value.trim() : null;
  }
}

function readListFields(body: Record<string, unknown>, patch: DepartmentPatch): void {
  for (const field of LIST_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) invalid(`${field} must be a list of text`);
    patch[field] = (value as string[]).map((entry) => entry.trim()).filter(Boolean);
  }
}

/** Validate a PATCH body into a patch. Unknown fields are refused rather than ignored. */
export function readDepartmentPatch(body: Record<string, unknown>): DepartmentPatch {
  const known = new Set<string>(["scope", "instructions", ...TEXT_FIELDS, ...LIST_FIELDS]);
  const unknown = Object.keys(body).filter((key) => !known.has(key));
  if (unknown.length > 0) invalid(`unknown field(s): ${unknown.join(", ")}`);
  const patch: DepartmentPatch = {};
  readScopeField(body, patch);
  readInstructionsField(body, patch);
  readTextFields(body, patch);
  readListFields(body, patch);
  return patch;
}

function readExisting(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new DepartmentWriteError("conflict", `the existing department.yaml cannot be read: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = yaml.load(raw);
  } catch (err) {
    throw new DepartmentWriteError("conflict", `the existing department.yaml does not parse (${(err as Error).message.split("\n")[0]}); fix it by hand first`);
  }
  if (data === undefined || data === null) return {};
  if (typeof data !== "object" || Array.isArray(data)) throw new DepartmentWriteError("conflict", "the existing department.yaml is not a YAML mapping; fix it by hand first");
  return data as Record<string, unknown>;
}

/** The file for `slug`, which must already have its directory under `org/`. */
export function departmentFilePath(slug: string): string {
  return path.join(resolveJinnHome(), "org", slug, "department.yaml");
}

/**
 * A skill the stage directory refuses (a symlink inside it) is not offered, so a write does not add it
 * to the list as if it were. Only skills the write introduces are judged (one already in the file is the
 * operator's to fix by hand), and only for a department that stages anything: an open one does not.
 */
function refuseUnstageableSkills(home: string, existing: Record<string, unknown>, merged: Record<string, unknown>, patch: DepartmentPatch): void {
  if (merged.scope === undefined || merged.scope === "open") return;
  const already = new Set(Array.isArray(existing.skills) ? existing.skills : []);
  for (const skill of (patch.skills ?? []).filter((name) => !already.has(name))) {
    const reason = skillRefusal(path.join(home, "skills", skill));
    if (reason) invalid(`skills: "${skill}" cannot be copied to a stage directory: ${reason}`);
  }
}

/** Merge `patch` into the department's file and replace it atomically. Throws {@link DepartmentWriteError}; writes nothing on any refusal. */
export function writeDepartmentFile(slug: string, patch: DepartmentPatch): void {
  const home = resolveJinnHome();
  const file = departmentFilePath(slug);
  if (!fs.existsSync(path.dirname(file)) || !fs.statSync(path.dirname(file)).isDirectory()) {
    throw new DepartmentWriteError("not_found", `there is no org/${slug}/ directory`);
  }
  const existing = readExisting(file);
  const merged: Record<string, unknown> = existing.name === undefined ? { name: slug, ...existing } : { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const text = yaml.dump(merged, { lineWidth: -1, noRefs: true });
  // The same judgement the scan will make, applied before anything is written.
  const parsed = parseDepartmentYaml(slug, text, { home, judgeExtrasWhenOpen: true, workdirOptions: departmentWorkdirOptions(home) });
  if (!parsed.ok) invalid(parsed.error);
  // Only what this write touches is refused; an entry that was already dropped is the operator's to fix by hand.
  const introduced = parsed.warnings.filter((warning) => Object.keys(patch).some((field) => warning.startsWith(`${field}:`)));
  if (introduced.length > 0) invalid(introduced.join("; "));
  refuseUnstageableSkills(home, existing, merged, patch);
  const temp = path.join(path.dirname(file), `.department.yaml.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, text, { encoding: "utf-8", mode: 0o644 });
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}
