import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate, isPermissive } from "./third-party-notices.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

const LEGAL_FILES = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"];

test("the published files list names the licence, notice and third-party notices", () => {
  for (const file of LEGAL_FILES) assert.ok(manifest.files.includes(file), `package.json files is missing ${file}`);
});

test("the packaged LICENSE and NOTICE are the repository's own", () => {
  for (const file of ["LICENSE", "NOTICE"]) {
    assert.equal(
      fs.readFileSync(path.join(packageRoot, file), "utf8"),
      fs.readFileSync(path.join(repoRoot, file), "utf8"),
      `packages/jinn/${file} differs from the root ${file}; copy the root file over it`,
    );
  }
});

test("THIRD-PARTY-NOTICES.md matches a fresh scan of the web build's dependencies", () => {
  assert.equal(
    fs.readFileSync(path.join(packageRoot, "THIRD-PARTY-NOTICES.md"), "utf8"),
    generate(repoRoot),
    "THIRD-PARTY-NOTICES.md is out of date; run `pnpm notices:generate` in packages/jinn",
  );
});

test("the notices carry the fonts' OFL texts and the bundled UI libraries' licences", () => {
  const notices = fs.readFileSync(path.join(packageRoot, "THIRD-PARTY-NOTICES.md"), "utf8");
  assert.match(notices, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(notices, /^- react@/m);
  assert.match(notices, /^- workbox-core@/m);
});

test("npm pack would publish the licence, notice and third-party notices", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stderr);
  const [{ files }] = JSON.parse(result.stdout);
  const packed = new Set(files.map((entry) => entry.path));
  for (const file of [...LEGAL_FILES, "package.json"]) assert.ok(packed.has(file), `npm pack omits ${file}`);
});

test("a copyleft licence is not on the permissive list", () => {
  assert.equal(isPermissive("MIT"), true);
  assert.equal(isPermissive("(MIT OR GPL-3.0)"), true);
  assert.equal(isPermissive("GPL-3.0"), false);
  assert.equal(isPermissive("MIT AND LGPL-2.1"), false);
  assert.equal(isPermissive("UNKNOWN"), false);
});
