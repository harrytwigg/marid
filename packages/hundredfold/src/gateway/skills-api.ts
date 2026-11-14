import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { readJsonBody } from "./http-helpers.js";
import { json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import { updateSkillContent } from "./skills.js";
import type { ApiContext } from "./api.js";

/** Cap for editable SKILL.md bodies. */
const SKILL_CONTENT_BODY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/skills description cache, keyed by skill dir name and invalidated
 * by SKILL.md mtime (statSync is far cheaper than re-reading + re-parsing ~70
 * files per request).
 */
const skillDescriptionCache = new Map<string, { mtimeMs: number; description: string }>();

/**
 * First non-heading, non-empty line of a SKILL.md body, or "" when there is
 * none. Split out of parseSkillDescription only to keep this file inside the
 * max-depth cap api.ts is grandfathered out of; the search is unchanged.
 */
function firstBodyLine(bodyContent: string): string {
  const lines = bodyContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed;
    }
  }
  return "";
}

/** Extract a skill description from YAML frontmatter, ## Trigger section, or first paragraph. */
function parseSkillDescription(content: string): string {
  let description = "";
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) {
      description = descMatch[1].trim();
    }
  }
  if (!description) {
    const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
    if (triggerMatch) {
      description = triggerMatch[1].trim();
    } else {
      // Use first non-heading, non-empty, non-frontmatter line
      const bodyContent = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
      description = firstBodyLine(bodyContent);
    }
  }
  return description;
}

/** Every installed skill with its description. Shared with global search, which
 *  needs the values rather than a written response. */
export function listSkills(): { name: string; description: string }[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => {
    const skillMdPath = path.join(SKILLS_DIR, e.name, "SKILL.md");
    const st = fs.statSync(skillMdPath, { throwIfNoEntry: false });
    if (!st) {
      skillDescriptionCache.delete(e.name);
      return { name: e.name, description: "" };
    }
    const hit = skillDescriptionCache.get(e.name);
    if (hit && hit.mtimeMs === st.mtimeMs) return { name: e.name, description: hit.description };
    const description = parseSkillDescription(fs.readFileSync(skillMdPath, "utf-8"));
    skillDescriptionCache.set(e.name, { mtimeMs: st.mtimeMs, description });
    return { name: e.name, description };
  });
}

// GET /api/skills/:name
function readSkill(res: ServerResponse, name: string): void {
  const skillMd = path.join(SKILLS_DIR, name, "SKILL.md");
  if (!fs.existsSync(skillMd)) return notFound(res);
  const content = fs.readFileSync(skillMd, "utf-8");
  return json(res, { name, content });
}

// PUT /api/skills/:name — replace an existing skill's SKILL.md
async function updateSkill(req: HttpRequest, res: ServerResponse, name: string): Promise<void> {
  const parsed = await readJsonBody(req, res, { maxBytes: SKILL_CONTENT_BODY_MAX_BYTES });
  if (!parsed.ok) return;
  const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)
    ? parsed.body as Record<string, unknown>
    : {};
  const result = updateSkillContent(name, body.content);
  if (!result.ok) return json(res, { error: result.error }, result.status);
  skillDescriptionCache.delete(name);
  logger.info(`Skill updated via API: ${name}`);
  return json(res, { status: "updated", name, content: result.content });
}

// DELETE /api/skills/:name — remove a skill
async function deleteSkill(res: ServerResponse, name: string): Promise<void> {
  const skillDir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(skillDir)) return notFound(res);
  const { removeFromManifest } = await import("../cli/skills.js");
  removeFromManifest(name);
  fs.rmSync(skillDir, { recursive: true, force: true });
  logger.info(`Skill removed via API: ${name}`);
  return json(res, { status: "removed", name });
}

/** `/api/skills*` routes. See route-helpers.ts for the domain-module contract. */
export async function handleSkillsApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  _context: ApiContext,
): Promise<boolean> {
  const { method, pathname } = route;
  if (method === "GET" && pathname === "/api/skills") {
    json(res, listSkills());
    return true;
  }
  const params = matchRoute("/api/skills/:name", pathname);
  if (!params) return false;
  if (method === "GET") {
    readSkill(res, params.name);
    return true;
  }
  if (method === "PUT") {
    await updateSkill(req, res, params.name);
    return true;
  }
  if (method === "DELETE") {
    await deleteSkill(res, params.name);
    return true;
  }
  return false;
}
