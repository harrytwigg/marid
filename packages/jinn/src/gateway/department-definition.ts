import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { DepartmentScope } from "../work-items/department-scope.js";
import { normalisedWorkdir, workdirRefusal, type WorkdirOptions } from "./department-workdirs.js";

/**
 * One `org/<slug>/department.yaml`, read and judged (FR-001).
 *
 * Problems come in two kinds:
 *  - **Identity** problems refuse the whole file: YAML that does not parse, a
 *    `name` that is not the directory's, an unknown `scope`, or a non-open scope on a
 *    department that cannot be scoped. The department then keeps its last good scope.
 *  - **Content** problems drop only the bad entry and leave a warning: a missing
 *    skill, a working directory that fails FR-033, a shared-notes path outside
 *    `knowledge/` and `docs/`, an unknown instructions mode.
 */

export const DEPARTMENT_SCOPES: readonly DepartmentScope[] = ["open", "scoped", "dedicated"];
/** Departments the system owns. FR-006: they can never be scoped. */
export const UNSCOPABLE_DEPARTMENTS: ReadonlySet<string> = new Set(["system", "org"]);
export const INSTRUCTION_MODES = ["department", "department+company"] as const;
export type InstructionsMode = (typeof INSTRUCTION_MODES)[number];

export interface DepartmentDefinition {
  slug: string;
  scope: DepartmentScope;
  displayName: string | null;
  description: string | null;
  workdirs: string[];
  skills: string[];
  sharedNotes: string[];
  instructions: InstructionsMode;
}

export type ParsedDepartment =
  | { ok: true; definition: DepartmentDefinition; warnings: string[] }
  | { ok: false; error: string };

export interface ParseContext {
  /** `$JINN_HOME`, where `skills/` lives. */
  home: string;
  workdirOptions?: WorkdirOptions;
  /** Judge the extras of an open department too. A write does, so an entry that would be dropped once the scope changes is refused now. */
  judgeExtrasWhenOpen?: boolean;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A list field, tolerating a bare string and dropping non-strings. */
function stringList(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
    else warnings.push(`${field}: ignored a non-text entry`);
  }
  return out;
}

function keepSkills(names: string[], ctx: ParseContext, warnings: string[]): string[] {
  const kept: string[] = [];
  for (const name of names) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && fs.existsSync(path.join(ctx.home, "skills", name, "SKILL.md"))) {
      if (!kept.includes(name)) kept.push(name);
    } else {
      warnings.push(`skills: dropped "${name}", which is not an installed skill`);
    }
  }
  return kept;
}

/** A shared-notes entry as a normalised home-relative POSIX path, or null when it escapes `knowledge/` and `docs/`. */
function sharedNotePath(entry: string): string | null {
  if (path.isAbsolute(entry) || entry.includes("\\")) return null;
  const normal = path.posix.normalize(entry).replace(/\/$/, "");
  const [root] = normal.split("/");
  if (normal.startsWith("..") || (root !== "knowledge" && root !== "docs")) return null;
  return normal;
}

function keepSharedNotes(entries: string[], warnings: string[]): string[] {
  const kept: string[] = [];
  for (const entry of entries) {
    const normal = sharedNotePath(entry);
    if (normal) {
      if (!kept.includes(normal)) kept.push(normal);
    } else {
      warnings.push(`sharedNotes: dropped "${entry}", which is outside knowledge/ and docs/`);
    }
  }
  return kept;
}

function keepWorkdirs(entries: string[], ctx: ParseContext, warnings: string[]): string[] {
  const kept: string[] = [];
  for (const entry of entries) {
    const refusal = workdirRefusal(entry, ctx.workdirOptions);
    if (refusal) {
      warnings.push(`workdirs: dropped ${refusal}`);
      continue;
    }
    const normal = normalisedWorkdir(entry);
    if (!kept.includes(normal)) kept.push(normal);
  }
  return kept;
}

/** Read the scope key. `undefined` for an absent key; a string for a valid one; an error message otherwise. */
function readScope(value: unknown): { scope: DepartmentScope } | { error: string } {
  if (value === undefined || value === null) return { scope: "open" };
  if (typeof value === "string" && (DEPARTMENT_SCOPES as readonly string[]).includes(value)) {
    return { scope: value as DepartmentScope };
  }
  return { error: `unknown scope ${JSON.stringify(value)}; expected open, scoped or dedicated` };
}

/** The mapping a file holds, or why it is not one. An empty file is an empty definition. */
function readDocument(raw: string): { doc: Record<string, unknown> } | { error: string } {
  let data: unknown;
  try {
    data = yaml.load(raw);
  } catch (err) {
    return { error: `the YAML does not parse: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  if (data === undefined || data === null) return { doc: {} };
  if (typeof data !== "object" || Array.isArray(data)) return { error: "the file must hold a YAML mapping" };
  return { doc: data as Record<string, unknown> };
}

/** The scope the file declares, or the identity problem that refuses it. */
function readIdentity(slug: string, doc: Record<string, unknown>): { scope: DepartmentScope } | { error: string } {
  // An absent name is tolerated (the shipped docs never required one); a name that is
  // present and not the directory's is the copy-pasted file this check exists to catch.
  if (doc.name !== undefined && doc.name !== null && String(doc.name) !== slug) {
    return { error: `name "${String(doc.name)}" does not match the directory "${slug}"` };
  }
  const scoped = readScope(doc.scope);
  if ("error" in scoped) return scoped;
  if (scoped.scope !== "open" && UNSCOPABLE_DEPARTMENTS.has(slug)) return { error: `the "${slug}" department cannot be ${scoped.scope}` };
  return scoped;
}

/** Fill the fields only a scoped session reads, dropping bad entries with a warning. */
function readExtras(definition: DepartmentDefinition, doc: Record<string, unknown>, ctx: ParseContext, warnings: string[]): void {
  definition.workdirs = keepWorkdirs(stringList(doc.workdirs, "workdirs", warnings), ctx, warnings);
  definition.skills = keepSkills(stringList(doc.skills, "skills", warnings), ctx, warnings);
  definition.sharedNotes = keepSharedNotes(stringList(doc.sharedNotes, "sharedNotes", warnings), warnings);
  if (doc.instructions === undefined || doc.instructions === null) return;
  if ((INSTRUCTION_MODES as readonly unknown[]).includes(doc.instructions)) definition.instructions = doc.instructions as InstructionsMode;
  else warnings.push(`instructions: ignored ${JSON.stringify(doc.instructions)}; expected department or department+company`);
}

export function parseDepartmentYaml(slug: string, raw: string, ctx: ParseContext): ParsedDepartment {
  const read = readDocument(raw);
  if ("error" in read) return { ok: false, error: read.error };
  const identity = readIdentity(slug, read.doc);
  if ("error" in identity) return { ok: false, error: identity.error };
  const warnings: string[] = [];
  const definition: DepartmentDefinition = {
    slug,
    scope: identity.scope,
    displayName: optionalText(read.doc.displayName),
    description: optionalText(read.doc.description),
    workdirs: [],
    skills: [],
    sharedNotes: [],
    instructions: "department",
  };
  // Working directories, skills, shared Notes and the instructions mode only mean
  // something to a scoped session, so an open department does not read them.
  if (identity.scope !== "open" || ctx.judgeExtrasWhenOpen) readExtras(definition, read.doc, ctx, warnings);
  return { ok: true, definition, warnings };
}
