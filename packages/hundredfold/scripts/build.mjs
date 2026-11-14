#!/usr/bin/env node
/**
 * Cross-platform build for hundredfold.
 *
 * This was a shell one-liner (`rm -rf … && tsc && mkdir -p … && cp …`). npm and
 * pnpm run package scripts through the platform shell, which on Windows is cmd —
 * where none of those commands exist, so `pnpm build` failed with "The syntax of
 * the command is incorrect" and the repo could not be built there at all. Node's
 * own fs APIs do the same work on every platform.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertFilesExist,
  assertRelativeImportsResolve,
  parseEmittedFiles,
  removeTreeVerified,
} from "./dist-integrity.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayEventsRoot = path.resolve(packageRoot, "../gateway-events");
const dist = path.join(packageRoot, "dist");
const require = createRequire(import.meta.url);

/** Run TypeScript's own entry with the current Node. Resolving the JS entry
 *  instead of the `tsc` shim keeps this shell-free, which avoids both the
 *  Windows .CMD resolution problem and shell argument concatenation. */
function runTsc(args, cwd = packageRoot) {
  const tsc = require.resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 1. Build the neutral protocol explicitly. A package-local CLI build must not
//    depend on an ignored workspace dist left behind by a prior root build.
runTsc(["-p", "tsconfig.json"], gatewayEventsRoot);

// 2. Clear only the compiled output. dist/web is produced separately by
//    scripts/sync-web-dist.mjs and must survive a package rebuild. Removal is
//    retried when another process briefly holds files under the tree, and the
//    build stops if the tree is still there afterwards: compiling over a
//    half-removed dist/ is how a build could exit 0 with modules missing.
for (const dir of ["bin", "src"]) {
  removeTreeVerified(path.join(dist, dir));
}

// 3. Compile. tsc lists what it wrote so the result can be checked against disk
//    once the build is done.
const compile = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json", "--listEmittedFiles"], {
  cwd: packageRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["inherit", "pipe", "inherit"],
});
if (compile.error) throw compile.error;
if (compile.status !== 0) {
  process.stdout.write(compile.stdout);
  process.exit(compile.status ?? 1);
}
const emittedFiles = parseEmittedFiles(compile.stdout).map((file) => path.resolve(packageRoot, file));
if (emittedFiles.length === 0) throw new Error("build: tsc reported no emitted files");

// 4. Embed the neutral gateway protocol runtime and declaration. Backend source
//    consumes the workspace package through src/shared/gateway-events.ts, but
//    hundredfold is published independently. Copying both canonical artifacts into
//    that relative module keeps shipped JavaScript and declarations aligned.
const gatewayEventsRuntime = path.join(gatewayEventsRoot, "dist", "index.js");
const gatewayEventsDeclaration = path.join(gatewayEventsRoot, "dist", "index.d.ts");
const embeddedGatewayEventsRuntime = path.join(dist, "src", "shared", "gateway-events.js");
const embeddedGatewayEventsDeclaration = path.join(dist, "src", "shared", "gateway-events.d.ts");
const runtimeText = fs.readFileSync(gatewayEventsRuntime, "utf8")
  .replace(/\n?\/\/# sourceMappingURL=index\.js\.map\s*$/, "\n");
const declarationText = fs.readFileSync(gatewayEventsDeclaration, "utf8")
  .replace(/\n?\/\/# sourceMappingURL=index\.d\.ts\.map\s*$/, "\n");
fs.writeFileSync(embeddedGatewayEventsRuntime, runtimeText);
fs.writeFileSync(embeddedGatewayEventsDeclaration, declarationText);
fs.rmSync(`${embeddedGatewayEventsRuntime}.map`, { force: true });
fs.rmSync(`${embeddedGatewayEventsDeclaration}.map`, { force: true });
// The protocol is more than one module now — index re-exports ./payloads.js —
// so its siblings travel with it or the embedded declaration points at nothing.
// A name that collides with hundredfold's own shared/ module would silently overwrite
// it, which is worth stopping the build over rather than shipping.
const sharedDir = path.join(dist, "src", "shared");
for (const sibling of fs.readdirSync(path.join(gatewayEventsRoot, "dist"))) {
  if (sibling.startsWith("index.") || sibling.endsWith(".map")) continue;
  const target = path.join(sharedDir, sibling);
  if (fs.existsSync(target)) throw new Error(`gateway protocol module "${sibling}" collides with hundredfold's own src/shared/${sibling}`);
  fs.copyFileSync(path.join(gatewayEventsRoot, "dist", sibling), target);
}

// 5. Copy the Talk assets tsc does not emit (Markdown + Python live beside the
//    TypeScript). Missing files are not an error: they are optional extras.
const talkSource = path.join(packageRoot, "src", "talk");
const talkTarget = path.join(dist, "src", "talk");
fs.mkdirSync(talkTarget, { recursive: true });
let copied = 0;
try {
  for (const entry of fs.readdirSync(talkSource)) {
    if (!/\.(md|py)$/i.test(entry)) continue;
    fs.copyFileSync(path.join(talkSource, entry), path.join(talkTarget, entry));
    copied += 1;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
// 6. A build that exits 0 has produced a complete dist/: everything tsc wrote
//    is still on disk, and nothing under it imports a module that is not.
//    (the embedded protocol's own source maps are the one thing removed on purpose, in step 4).
const removedOnPurpose = new Set([`${embeddedGatewayEventsRuntime}.map`, `${embeddedGatewayEventsDeclaration}.map`]);
assertFilesExist(emittedFiles.filter((file) => !removedOnPurpose.has(file)));
assertRelativeImportsResolve([path.join(dist, "bin"), path.join(dist, "src")]);
console.log(`build: compiled to dist/, embedded gateway protocol, copied ${copied} talk asset(s)`);
