#!/usr/bin/env node
// Replaces every Jinn and Marid reference with the product name, case-preserving: jinn/marid -> hundredfold,
// Jinn/Marid -> Hundredfold, JINN/MARID -> HUNDREDFOLD. Rerunnable; the rules are in scripts/rename-codename/.
//
//   node scripts/rename-codename.mjs              report what would change, by area
//   node scripts/rename-codename.mjs --apply      rewrite the files, then move the paths
//   node scripts/rename-codename.mjs --check      exit 1 if anything would still change: the CI guard
//   --residue                                     list every file that still carries an old name, and why it may
//   --list                                        with --report or --check, print each file
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isBinary, renamePath, renameText } from "./rename-codename/engine.mjs";
import { FROZEN_SUBTREES, KEEP_CONTENT_PATHS, KEEP_PATTERNS } from "./rename-codename/rules.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const check = args.has("--check");
const list = args.has("--list");
const residue = args.has("--residue");

/** This script and its rules name the old words to say what they are: they are the one place that may. */
const SELF = /^scripts\/(?:rename-codename\.mjs|rename-codename\/|__tests__\/rename-codename\.test\.mjs)/;

const everything = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\0")
  .filter(Boolean)
  .filter((file) => !SELF.test(file));
const tracked = new Set(everything);

const rewrites = [];
const moves = [];
const kept = [];
for (const file of everything) {
  const target = tracked.has(file) ? renamePath(file, FROZEN_SUBTREES) : file;
  if (target !== file) moves.push([file, target]);
  if (KEEP_CONTENT_PATHS.some((rule) => rule.test(file))) continue;
  const full = path.join(root, file);
  const stat = fs.lstatSync(full);
  if (!stat.isFile()) continue;
  const buffer = fs.readFileSync(full);
  if (isBinary(buffer)) continue;
  const result = renameText(buffer.toString("utf8"), KEEP_PATTERNS);
  if (result.changed) rewrites.push([file, result.text]);
  if (result.left.length > 0) kept.push([file, result.left.length]);
}

if (residue) {
  const why = (file) => {
    if (/^packages\/[^/]+\/template\/migrations\//.test(file)) return "released migration bundle (merge base, byte-identical)";
    if (/^(?:packages\/[^/]+\/)?(?:LICENSE|NOTICE)$/.test(file)) return "licence attribution";
    if (/^packages\/shell\/src-tauri\/gen\//.test(file)) return "generated app project (bundle id and crate names kept)";
    if (file === "CHANGELOG.md") return "released history";
    if (/\/__tests__\/|\.test\.[cm]?[jt]sx?$/.test(file)) return "test of how an old install is read";
    if (/^docs\/|\.md$/.test(file)) return "documentation of the old names or the attribution";
    return "code that reads the old names";
  };
  const counts = {};
  for (const file of everything) {
    const full = path.join(root, file);
    if (!fs.lstatSync(full).isFile()) continue;
    const buffer = fs.readFileSync(full);
    if (isBinary(buffer)) continue;
    const n = buffer.toString("utf8").split("\n").filter((line) => /jinn|marid/i.test(line)).length;
    if (n > 0 || /jinn|marid/i.test(file)) {
      const key = why(file);
      counts[key] ??= { files: 0, lines: 0 };
      counts[key].files += 1;
      counts[key].lines += n;
      if (list) console.log(`${n}\t${key}\t${file}`);
    }
  }
  console.log(JSON.stringify(counts, null, 2));
  process.exit(0);
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
