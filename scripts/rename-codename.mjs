#!/usr/bin/env node
// Replaces every Jinn and Marid reference with the product name, case-preserving: jinn/marid -> hundredfold,
// Jinn/Marid -> Hundredfold, JINN/MARID -> HUNDREDFOLD. Rerunnable; the rules are in scripts/rename-codename/.
//
//   node scripts/rename-codename.mjs              report what would change, by area
//   node scripts/rename-codename.mjs --apply      rewrite the files, then move the paths
//   node scripts/rename-codename.mjs --check      exit 1 if anything would still change: the CI guard
//   --skip-docs                                   leave docs, specs and READMEs to the documentation step
//   --skip-distribution                           leave install and publish names to the distribution step
//   --list                                        with --report or --check, print each file
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isBinary, renamePath, renameText } from "./rename-codename/engine.mjs";
import { DISTRIBUTION_PATHS, DISTRIBUTION_PATTERNS, DOCS_SCOPE, FROZEN_SUBTREES, KEEP_CONTENT_PATHS, KEEP_PATTERNS } from "./rename-codename/rules.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const check = args.has("--check");
const skipDocs = args.has("--skip-docs");
const skipDistribution = args.has("--skip-distribution");
const list = args.has("--list");
const keepPatterns = skipDistribution ? [...KEEP_PATTERNS, ...DISTRIBUTION_PATTERNS] : KEEP_PATTERNS;

/** This script and its rules name the old words to say what they are: they are the one place that may. */
const SELF = /^scripts\/(?:rename-codename\.mjs|rename-codename\/|__tests__\/rename-codename\.test\.mjs)/;

const everything = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\0")
  .filter(Boolean)
  .filter((file) => !SELF.test(file));
/** The package directory moves whole, whatever step owns the files in it: half a package is not a package. */
const MOVES_WHOLE = /^packages\/jinn\//;
const outOfScope = (file) =>
  (skipDocs && DOCS_SCOPE.some((scope) => scope.test(file))) ||
  (skipDistribution && DISTRIBUTION_PATHS.some((scope) => scope.test(file)));
const tracked = everything.filter((file) => MOVES_WHOLE.test(file) || !outOfScope(file));

const rewrites = [];
const moves = [];
const kept = [];
for (const file of tracked) {
  const target = renamePath(file, FROZEN_SUBTREES);
  if (target !== file) moves.push([file, target]);
  if (KEEP_CONTENT_PATHS.some((rule) => rule.test(file)) || outOfScope(file)) continue;
  const full = path.join(root, file);
  const stat = fs.lstatSync(full);
  if (!stat.isFile()) continue;
  const buffer = fs.readFileSync(full);
  if (isBinary(buffer)) continue;
  const result = renameText(buffer.toString("utf8"), keepPatterns);
  if (result.changed) rewrites.push([file, result.text]);
  if (result.left.length > 0) kept.push([file, result.left.length]);
}

const area = (file) => file.split("/").slice(0, 2).join("/");
const tally = (entries) => entries.reduce((acc, [file]) => ((acc[area(file)] = (acc[area(file)] ?? 0) + 1), acc), {});

if (check) {
  if (rewrites.length === 0 && moves.length === 0) {
    console.log(`rename-codename: clean (${kept.length} files keep an allowed old name)`);
    process.exit(0);
  }
  console.error(`rename-codename: ${rewrites.length} files still carry an old name and ${moves.length} paths still carry one.`);
  for (const [file] of rewrites.slice(0, 40)) console.error(`  content  ${file}`);
  for (const [file] of moves.slice(0, 20)) console.error(`  path     ${file}`);
  console.error("Run `node scripts/rename-codename.mjs --apply`, or add the case to scripts/rename-codename/rules.mjs / mark the line `rename:keep` with a reason.");
  process.exit(1);
}

if (!apply) {
  console.log(`${rewrites.length} files to rewrite, ${moves.length} paths to move, ${kept.length} files keep an allowed old name.`);
  console.log("rewrite by area:", tally(rewrites));
  if (list) for (const [file] of rewrites) console.log(`  content  ${file}`);
  if (list) for (const [from, to] of moves) console.log(`  move     ${from} -> ${to}`);
  process.exit(0);
}

for (const [file, text] of rewrites) fs.writeFileSync(path.join(root, file), text);
for (const [from, to] of moves) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.renameSync(path.join(root, from), path.join(root, to));
}
execFileSync("git", ["add", "-A"], { cwd: root });
console.log(`rewrote ${rewrites.length} files, moved ${moves.length} paths.`);
