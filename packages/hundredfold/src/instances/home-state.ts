import fs from "node:fs";
import path from "node:path";
import { NAMES, currentHomePath, legacyHomePath, type Names } from "../shared/codename.js";

/**
 * Where a home stands between the name an earlier codename gave it and the one this build gives it, read
 * from the file system alone: what a move would act on and what `doctor` reports.
 */

export type Kind = "absent" | "directory" | "symlink" | "other";

export function kindOf(target: string): Kind {
  try {
    const stat = fs.lstatSync(target);
    return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "other";
  } catch {
    return "absent";
  }
}

export function sameDirectory(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

/** The home this build would use for `home`, and the one an earlier codename used: the same path when `home` never carried the codename. */
export function pairFor(home: string, names: Names): { current: string; legacy: string } {
  const current = currentHomePath(path.resolve(home), names);
  return { current, legacy: legacyHomePath(current, names) };
}

/** A legacy-named path that is a link left by an earlier move, to the current-named directory. */
export function linkToCurrent(legacy: string, current: string): boolean {
  return kindOf(legacy) === "symlink" && sameDirectory(legacy, current);
}

export function decide(legacy: string, current: string): "nothing" | "move" | "conflict" | "kept-link" {
  const [here, there] = [kindOf(current), kindOf(legacy)];
  if (here === "directory" && there === "directory") return "conflict";
  if (here === "absent" && there === "directory") return "move";
  if (here === "absent" && there === "symlink") return "kept-link";
  return "nothing";
}

export type HomeState = "not-named-for-codename" | "current" | "pending-move" | "moved" | "conflict" | "legacy-link-elsewhere" | "absent";

/** Where `home` stands, without changing anything: what `doctor` reports and a move would act on. */
export function inspectHome(home: string, names: Names = NAMES): { state: HomeState; current: string; legacy: string } {
  const { current, legacy } = pairFor(home, names);
  if (current === legacy) return { state: "not-named-for-codename", current, legacy };
  if (linkToCurrent(legacy, current)) return { state: "moved", current, legacy };
  const verdict = decide(legacy, current);
  if (verdict === "conflict") return { state: "conflict", current, legacy };
  if (verdict === "move") return { state: "pending-move", current, legacy };
  if (verdict === "kept-link") return { state: "legacy-link-elsewhere", current, legacy };
  return { state: kindOf(current) === "absent" ? "absent" : "current", current, legacy };
}

