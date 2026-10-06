import fs from "node:fs";
import path from "node:path";

/**
 * The real directory a knowledge search walks for root `label` (a path relative to the
 * instance home), or null when there is nothing to walk. A top-level root (`knowledge`,
 * `docs`) is taken as it always was. A nested root, which a department-scoped search passes
 * (`knowledge/departments/<slug>`, a shared folder), must be exactly where its name says
 * under the real home: a link anywhere along it would walk, and return snippets from,
 * a tree outside the instance.
 */
export function realSearchRoot(home: string, label: string): string | null {
  try {
    const real = fs.realpathSync(path.join(home, label));
    return !label.includes("/") || real === path.join(fs.realpathSync(home), label) ? real : null;
  } catch {
    return null;
  }
}
