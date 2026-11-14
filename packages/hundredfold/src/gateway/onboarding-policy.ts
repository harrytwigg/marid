import fs from "node:fs";
import path from "node:path";
import { LEGACY_PORTAL_NAME } from "../shared/brand.js";

/**
 * Onboarding gate policy.
 * The wizard is needed if and only if the `onboarded` flag has not been set.
 * Employees and sessions are irrelevant — setup always seeds an employee,
 * so checking them caused the wizard to never appear.
 */
export function onboardingNeeded(onboarded: boolean): boolean {
  return !onboarded;
}

export interface EngineChoice {
  engine?: string;
  model?: string;
  effortLevel?: string;
}

/**
 * Merges engine/model/effortLevel selections from the onboarding wizard
 * into the gateway config, setting `engines.default` and per-engine fields.
 * Returns the config unchanged (same reference) when no engine is provided.
 */
export function applyEngineChoice<T extends { engines: Record<string, any> }>(
  cfg: T,
  c: EngineChoice
): T {
  if (!c.engine) return cfg;
  const engines: Record<string, any> = { ...cfg.engines, default: c.engine };
  engines[c.engine] = {
    ...(engines[c.engine] ?? {}),
    ...(c.model ? { model: c.model } : {}),
    ...(c.effortLevel ? { effortLevel: c.effortLevel } : {}),
  };
  return { ...cfg, engines } as T;
}

/**
 * Personalizes the instance's operating manual with the chosen COO name and
 * language. The shipped identity line is bold, e.g.
 *   "You are **Hundredfold**, a personal AI assistant and COO of an AI organization."
 * (The previous CLAUDE.md regex expected unbolded "...the COO of the user's AI
 * organization." and never matched, so the rename silently no-op'd.)
 *
 * CLAUDE.md is canonical. AGENTS.md is normally a symlink to it, so the symlink
 * is skipped and only the rare non-symlink fallback copy is personalized too.
 */
export function personalizeOperatingManual(
  home: string,
  opts: { portalName?: string; language?: string }
): void {
  const effectiveName = opts.portalName || LEGACY_PORTAL_NAME;
  const languageSection = opts.language && opts.language !== "English"
    ? `\n\n## Language\nAlways respond in ${opts.language}. All communication with the user must be in ${opts.language}.`
    : "";

  const personalize = (filePath: string) => {
    let md = fs.readFileSync(filePath, "utf-8");
    // Replace just the bold name token; `[^*]+` supports multi-word names.
    md = md.replace(/^You are \*\*[^*]+\*\*/m, `You are **${effectiveName}**`);
    // Reset any prior language section, then append the new one if needed.
    md = md.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
    if (languageSection) md = md.trimEnd() + languageSection + "\n";
    fs.writeFileSync(filePath, md);
  };

  const claudeMdPath = path.join(home, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) personalize(claudeMdPath);

  const agentsMdPath = path.join(home, "AGENTS.md");
  if (fs.existsSync(agentsMdPath) && !fs.lstatSync(agentsMdPath).isSymbolicLink()) {
    personalize(agentsMdPath);
  }
}
