import path from "node:path"
import { LEGACY_PORTAL_NAME } from "./brand.js"

export interface TemplateMaterializationInputs {
  portalName: string
  portalSlug: string
}

export interface TemplateMaterializationConfig {
  portal?: {
    portalName?: string
  }
}

const MATERIALIZED_EXTENSIONS = new Set([".md", ".yaml", ".yml"])

export function isTemplateMaterializationPath(filePath: string): boolean {
  return MATERIALIZED_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function deriveTemplateMaterializationInputs(
  config: TemplateMaterializationConfig | null | undefined,
): TemplateMaterializationInputs {
  const portalName = config?.portal?.portalName || LEGACY_PORTAL_NAME
  return {
    portalName,
    portalSlug: portalName.toLowerCase().replace(/\s+/g, "-"),
  }
}

export function materializeTemplateContent(
  filePath: string,
  content: string,
  inputs: TemplateMaterializationInputs,
): string {
  if (!isTemplateMaterializationPath(filePath)) return content
  return content
    .replaceAll("{{portalName}}", inputs.portalName)
    .replaceAll("{{portalSlug}}", inputs.portalSlug)
}

export function materializeTemplateBytes(
  filePath: string,
  content: Buffer,
  inputs: TemplateMaterializationInputs,
): Buffer {
  if (!isTemplateMaterializationPath(filePath)) return content
  return Buffer.from(materializeTemplateContent(filePath, content.toString("utf8"), inputs), "utf8")
}

/**
 * A template placeholder is a bare name: `{{portalName}}`, optionally padded.
 * Matching the shape rather than a fixed vocabulary keeps this forward-compatible,
 * so a placeholder a newer template introduces is still reported as unresolved by
 * an older materializer that cannot substitute it.
 *
 * It deliberately does NOT match a dotted expression such as `{{ trigger.round }}`.
 * Those are Workflow binding expressions, which shipped documentation quotes
 * verbatim; they are never substituted here and must not be mistaken for a
 * placeholder that failed to resolve.
 */
const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g

export function findUnresolvedTemplatePlaceholders(content: string): string[] {
  return [...new Set(content.match(TEMPLATE_PLACEHOLDER_PATTERN) ?? [])].sort()
}
