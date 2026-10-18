#!/usr/bin/env node
/**
 * Generates packages/jinn/THIRD-PARTY-NOTICES.md.
 *
 * jinn-cli publishes the web dashboard (dist/web) with its dependencies bundled
 * in, so their licence notices have to travel with the tarball. This scans the
 * dependency set the web build bundles and writes one notices file:
 *
 *   - the production dependency closure of packages/web, read from the
 *     installed node_modules (so run it after `pnpm install`);
 *   - the Workbox runtime that vite-plugin-pwa copies into the service worker
 *     (a build tool, but its output ships in dist/web);
 *   - material vendored in the web source with its own notice: the SIL OFL
 *     texts beside the fonts and any NOTICE.md in a directory that vendors
 *     third-party code.
 *
 * `--check` leaves the file alone and exits non-zero when it is out of date.
 * A package whose licence is not on the permissive list fails the run rather
 * than being published unreviewed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const outputFile = path.join(packageRoot, "THIRD-PARTY-NOTICES.md");

/** Licences the bundle may carry without a decision from the maintainers. */
export const PERMISSIVE_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Python-2.0",
  "Unlicense",
]);

/** The Workbox modules the generated service worker carries, reached through
 *  vite-plugin-pwa -> workbox-build. They are a build tool's dependencies, so
 *  the production closure of the web package does not see them. */
const SERVICE_WORKER_RUNTIME = ["workbox-core", "workbox-precaching", "workbox-routing", "workbox-strategies"];

const LICENSE_FILE = /^(licen[cs]e|copying)([-._].*)?$/i;

/** Code-unit order, so the output does not depend on the machine's locale. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Licence text as published: LF endings, and no contact addresses. The names
 *  and years carry the attribution; an email address is personal data the
 *  notice does not need. */
function cleanText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]*<(?:mailto:)?[^<>\s@]+@[^<>\s]+>/g, "")
    .replace(/\(?mailto:[^\s)]+\)?/g, "")
    .replace(/[^\s<>()]+@[^\s<>()]+\.[a-z]{2,}/gi, "")
    .trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Find an installed package the way Node would: nearest node_modules up the
 *  tree from the dependent. The dependent is a realpath, which under pnpm puts
 *  its own dependencies next to it. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

function declaredLicense(manifest) {
  const value = manifest.license ?? manifest.licenses;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return value.type ?? "UNKNOWN";
  if (Array.isArray(value)) return value.map((entry) => entry.type ?? "UNKNOWN").join(" OR ");
  return "UNKNOWN";
}

/** A package that offers a choice ("MIT OR Apache-2.0") is fine when any
 *  alternative is permissive; a conjunction needs all of them to be. */
export function isPermissive(expression) {
  const text = expression.replace(/[()]/g, " ");
  return text.split(/\s+OR\s+/i).some((alternative) =>
    alternative.split(/\s+AND\s+/i).every((id) => PERMISSIVE_LICENSES.has(id.trim())));
}

function licenseText(dir, manifest, license) {
  const files = fs.readdirSync(dir).filter((entry) => LICENSE_FILE.test(entry)).sort();
  const text = files
    .map((file) => cleanText(fs.readFileSync(path.join(dir, file), "utf8")))
    .filter(Boolean)
    .join("\n\n");
  if (text) return text;
  // Some packages ship no licence file. Record what their manifest declares so
  // the attribution is still there and the gap is visible.
  const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  return [
    `${manifest.name} ships no licence file; its package.json declares the ${license} licence.`,
    author && `Author: ${author.replace(/\s*<[^>]*>/, "")}`,
    repository && `Repository: ${repository.replace(/^git\+/, "")}`,
  ].filter(Boolean).join("\n");
}

/** Walk the dependency closure from the given manifests. Workspace packages are
 *  this repository's own code and are skipped. */
function collectClosure(roots) {
  const seen = new Map();
  const queue = [...roots];
  while (queue.length > 0) {
    const { dir, optional } = queue.shift();
    const manifest = readJson(path.join(dir, "package.json"));
    const key = `${manifest.name}@${manifest.version}`;
    if (seen.has(key)) continue;
    seen.set(key, { manifest, dir, optional });
    const deps = { ...manifest.optionalDependencies, ...manifest.dependencies };
    for (const [name, range] of Object.entries(deps)) {
      if (String(range).startsWith("workspace:")) continue;
      const resolved = resolvePackage(name, dir);
      if (resolved) queue.push({ dir: resolved, optional: Boolean(manifest.optionalDependencies?.[name]) });
      else if (!manifest.optionalDependencies?.[name]) {
        throw new Error(`third-party-notices: ${key} depends on ${name}, which is not installed; run pnpm install first`);
      }
    }
  }
  return [...seen.values()];
}

export function collectNpmPackages(root = repoRoot) {
  const webDir = path.join(root, "packages", "web");
  const web = readJson(path.join(webDir, "package.json"));
  const roots = [];
  for (const [name, range] of Object.entries(web.dependencies ?? {})) {
    if (String(range).startsWith("workspace:")) continue;
    const dir = resolvePackage(name, webDir);
    if (!dir) throw new Error(`third-party-notices: ${name} is not installed; run pnpm install first`);
    roots.push({ dir });
  }

  const pwa = resolvePackage("vite-plugin-pwa", webDir);
  const workboxBuild = pwa && resolvePackage("workbox-build", pwa);
  if (!workboxBuild) throw new Error("third-party-notices: workbox-build is not installed; run pnpm install first");
  for (const name of SERVICE_WORKER_RUNTIME) {
    const dir = resolvePackage(name, workboxBuild);
    if (!dir) throw new Error(`third-party-notices: ${name} is not installed; run pnpm install first`);
    roots.push({ dir });
  }

  return collectClosure(roots)
    .map(({ manifest, dir }) => {
      const license = declaredLicense(manifest);
      if (!isPermissive(license)) {
        throw new Error(
          `third-party-notices: ${manifest.name}@${manifest.version} is licensed ${license}, which is not on the permissive list; ` +
            "a maintainer has to decide whether the web build may bundle it",
        );
      }
      return { name: manifest.name, version: manifest.version, license, text: licenseText(dir, manifest, license) };
    })
    .sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.version, b.version));
}

/** Notice files committed beside vendored web code or assets. */
export function collectVendored(root = repoRoot) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "NOTICE.md" || /^OFL-.*\.txt$/.test(entry.name)) found.push(full);
    }
  };
  walk(path.join(root, "packages", "web", "src"));
  return found
    .map((file) => ({
      path: path.relative(root, file).split(path.sep).join("/"),
      text: cleanText(fs.readFileSync(file, "utf8")),
    }))
    .sort((a, b) => byCodeUnit(a.path, b.path));
}

/** Packages that ship the identical licence text share one block. */
function groupByText(packages) {
  const groups = new Map();
  for (const pkg of packages) {
    if (!groups.has(pkg.text)) groups.set(pkg.text, { text: pkg.text, licenses: new Set(), packages: [] });
    const group = groups.get(pkg.text);
    group.licenses.add(pkg.license);
    group.packages.push(`${pkg.name}@${pkg.version}`);
  }
  return [...groups.values()].sort((a, b) => byCodeUnit(a.packages[0], b.packages[0]));
}

export function renderNotices({ packages, vendored }) {
  const lines = [
    "# Third-party notices",
    "",
    "The published package bundles the following third-party material in the web",
    "dashboard (`dist/web`). This file is generated by `scripts/third-party-notices.mjs`;",
    "do not edit it by hand.",
    "",
    "## Vendored in the web source",
    "",
  ];
  for (const item of vendored) {
    lines.push(`### \`${item.path}\``, "", "```text", item.text, "```", "");
  }
  lines.push("## npm packages", "");
  for (const group of groupByText(packages)) {
    lines.push(`### ${[...group.licenses].sort().join(", ")}`, "", ...group.packages.map((p) => `- ${p}`), "");
    lines.push("```text", group.text, "```", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function generate(root = repoRoot) {
  return renderNotices({ packages: collectNpmPackages(root), vendored: collectVendored(root) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = generate();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
    if (current !== rendered) {
      console.error("THIRD-PARTY-NOTICES.md is out of date; run `node scripts/third-party-notices.mjs` in packages/jinn and commit the result.");
      process.exit(1);
    }
    console.log("THIRD-PARTY-NOTICES.md is up to date");
  } else {
    fs.writeFileSync(outputFile, rendered);
    console.log(`wrote ${path.relative(repoRoot, outputFile)}`);
  }
}
