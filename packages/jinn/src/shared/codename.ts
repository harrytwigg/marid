/**
 * The codename: the lower-case word that environment variables, instance names, home
 * directories, wire headers, the MCP server and every other on-disk or on-the-wire
 * name are built from.
 *
 * Existing installs persist the name they were created under. Changing {@link CODENAME}
 * therefore needs two things that this module and its siblings supply: every place that
 * writes a name writes the current one, and every place that reads one accepts the
 * {@link LEGACY_CODENAME} form as well. While the two are equal, every alias below
 * collapses to the single name and nothing changes.
 *
 * Functions take a {@link Names} so a test can exercise a rename without rebuilding the
 * package: `namesFor("acme")` stands in for a build whose constant says "acme". Code that
 * derives a name at load time reads it from here, so a test of that mocks
 * `codename-constant.js`, which holds the one literal.
 */

import path from "node:path";
import { CODENAME } from "./codename-constant.js";

export { CODENAME };

/** The name every install made before a rename carries. Never changes. */
export const LEGACY_CODENAME = "jinn";

export interface Names {
  /** The lower-case form: `jinn`, a header segment, an instance name. */
  readonly codename: string;
  /** The env-variable prefix form: `JINN`. */
  readonly upper: string;
  /** The display form that on-disk names use on macOS and Windows: `Jinn`. */
  readonly title: string;
  /** Whether this build's name differs from {@link LEGACY_CODENAME}, so aliases exist. */
  readonly renamed: boolean;
}

export function namesFor(codename: string): Names {
  if (!/^[a-z][a-z0-9]*$/.test(codename)) throw new Error(`invalid codename "${codename}"`);
  return {
    codename,
    upper: codename.toUpperCase(),
    title: codename.charAt(0).toUpperCase() + codename.slice(1),
    renamed: codename !== LEGACY_CODENAME,
  };
}

export const NAMES: Names = namesFor(CODENAME);
export const LEGACY_NAMES: Names = namesFor(LEGACY_CODENAME);

/** Every distinct spelling of one name, the current one first: the order a reader tries them in. */
export function nameAliases(build: (names: Names) => string, names: Names = NAMES): string[] {
  const current = build(names);
  const legacy = build(LEGACY_NAMES);
  return current === legacy ? [current] : [current, legacy];
}

/** The instance name for the default home, and the prefix of every other: `jinn`, `jinn-<slug>`. */
export function instanceNameFor(slug: string | undefined, names: Names = NAMES): string {
  return slug ? `${names.codename}-${slug}` : names.codename;
}

/**
 * The name this build would give an instance that an older build named `name`:
 * `jinn` becomes the codename, `jinn-<slug>` becomes `<codename>-<slug>`, anything else
 * (an instance whose name never carried the codename) stays as it is.
 */
export function currentInstanceName(name: string, names: Names = NAMES): string {
  if (name === LEGACY_CODENAME) return names.codename;
  if (name.startsWith(`${LEGACY_CODENAME}-`)) return `${names.codename}-${name.slice(LEGACY_CODENAME.length + 1)}`;
  return name;
}

/** Inverse of {@link currentInstanceName}: what an older build called an instance this build names `name`. */
export function legacyInstanceName(name: string, names: Names = NAMES): string {
  if (name === names.codename) return LEGACY_CODENAME;
  if (name.startsWith(`${names.codename}-`)) return `${LEGACY_CODENAME}-${name.slice(names.codename.length + 1)}`;
  return name;
}

/** Whether two instance names, in either spelling, name the same instance. */
export function sameInstanceName(a: string, b: string, names: Names = NAMES): boolean {
  return currentInstanceName(a, names) === currentInstanceName(b, names);
}

/** Whether `name` is the default instance's name, in either spelling. */
export function isDefaultInstanceName(name: string, names: Names = NAMES): boolean {
  return currentInstanceName(name, names) === names.codename;
}

/**
 * The directory a home an older build named would have under this build's naming: the dotted
 * directory name `.jinn-<slug>` becomes `.<codename>-<slug>` in the same parent. A path whose last
 * segment never carried the codename (a home the operator put wherever they liked) is returned as it is.
 */
export function currentHomePath(home: string, names: Names = NAMES): string {
  return mapHomeBase(home, (name) => currentInstanceName(name, names));
}

/** Inverse of {@link currentHomePath}: the path an older build would have kept this home at. */
export function legacyHomePath(home: string, names: Names = NAMES): string {
  return mapHomeBase(home, (name) => legacyInstanceName(name, names));
}

function mapHomeBase(home: string, map: (instance: string) => string): string {
  const base = path.basename(home);
  if (!base.startsWith(".")) return home;
  const mapped = map(base.slice(1));
  return mapped === base.slice(1) ? home : path.join(path.dirname(home), `.${mapped}`);
}
