import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertFilesExist,
  assertRelativeImportsResolve,
  parseEmittedFiles,
  relativeImports,
  removeTreeVerified,
} from "./dist-integrity.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function transient(code) {
  return Object.assign(new Error(`${code}, simulated`), { code });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dist-integrity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("removeTreeVerified removes a real tree", (t) => {
  const root = tempDir(t);
  const target = path.join(root, "src");
  fs.mkdirSync(path.join(target, "nested"), { recursive: true });
  fs.writeFileSync(path.join(target, "nested", "a.js"), "");
  removeTreeVerified(target);
  assert.equal(fs.existsSync(target), false);
});

test("removeTreeVerified accepts a target that is already absent", (t) => {
  removeTreeVerified(path.join(tempDir(t), "missing"));
});

test("removeTreeVerified retries ENOTEMPTY and EBUSY until the tree is gone", (t) => {
  const root = tempDir(t);
  const target = path.join(root, "src");
  fs.mkdirSync(target);
  const failures = [transient("ENOTEMPTY"), transient("EBUSY")];
  let calls = 0;
  removeTreeVerified(target, {
    sleep: () => {},
    rm: (dir, opts) => {
      calls += 1;
      const failure = failures.shift();
      if (failure) throw failure;
      fs.rmSync(dir, opts);
    },
  });
  assert.equal(calls, 3);
  assert.equal(fs.existsSync(target), false);
});

test("removeTreeVerified stops the build when a directory resists removal", (t) => {
  const target = path.join(tempDir(t), "src");
  fs.mkdirSync(target);
  let calls = 0;
  assert.throws(
    () =>
      removeTreeVerified(target, {
        attempts: 3,
        sleep: () => {},
        rm: () => {
          calls += 1;
          throw transient("ENOTEMPTY");
        },
      }),
    /could not clean .*ENOTEMPTY.*refusing to compile over a partial tree/,
  );
  assert.equal(calls, 3);
  assert.ok(fs.existsSync(target), "the tree it could not remove is left alone");
});

test("removeTreeVerified does not trust a removal that left the tree behind", (t) => {
  const target = path.join(tempDir(t), "src");
  fs.mkdirSync(target);
  assert.throws(
    () => removeTreeVerified(target, { attempts: 2, sleep: () => {}, rm: () => {} }),
    /still exists after removal/,
  );
});

test("removeTreeVerified does not retry errors that are not transient", (t) => {
  let calls = 0;
  assert.throws(
    () =>
      removeTreeVerified(path.join(tempDir(t), "src"), {
        sleep: () => {},
        rm: () => {
          calls += 1;
          throw transient("EINVAL");
        },
      }),
    /EINVAL/,
  );
  assert.equal(calls, 1);
});

test("removeTreeVerified survives a real tree being refilled while it is removed", (t) => {
  // A writer racing the removal is the real-world trigger for ENOTEMPTY.
  const root = tempDir(t);
  const target = path.join(root, "src");
  fs.mkdirSync(target);
  let refills = 2;
  removeTreeVerified(target, {
    sleep: () => {},
    rm: (dir, opts) => {
      fs.rmSync(dir, opts);
      if (refills-- > 0) {
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "late.js"), "");
      }
    },
  });
  assert.equal(fs.existsSync(target), false);
});

test("parseEmittedFiles reads tsc's --listEmittedFiles output and ignores the rest", () => {
  const output = ["TSFILE: /x/dist/src/a.js", "src/b.ts(1,1): error TS1000: nope", "TSFILE: /x/dist/src/a.d.ts", ""].join("\n");
  assert.deepEqual(parseEmittedFiles(output), ["/x/dist/src/a.js", "/x/dist/src/a.d.ts"]);
});

test("assertFilesExist names the files that are missing", (t) => {
  const root = tempDir(t);
  const present = path.join(root, "present.js");
  fs.writeFileSync(present, "");
  assertFilesExist([present]);
  assert.throws(() => assertFilesExist([present, path.join(root, "gone.js")]), /1 compiled file\(s\) missing[\s\S]*gone\.js/);
});

test("relativeImports finds static, dynamic and re-export specifiers but not packages", () => {
  const source = [
    'import a from "./a.js";',
    'import { b } from "../b.js";',
    'export * from "./c.js";',
    'export { d } from "./d.js";',
    'const e = await import("./e.js");',
    'import fs from "node:fs";',
    'import z from "zod";',
  ].join("\n");
  assert.deepEqual(relativeImports(source), ["./a.js", "../b.js", "./c.js", "./d.js", "./e.js"]);
});

test("assertRelativeImportsResolve catches an importer whose dependency was never emitted", (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, "work-items"), { recursive: true });
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  fs.writeFileSync(path.join(root, "work-items", "migrate.js"), 'import { guard } from "../shared/local-db-guard.js";\n');
  assert.throws(
    () => assertRelativeImportsResolve([root]),
    /unresolved relative import[\s\S]*migrate\.js imports \.\.\/shared\/local-db-guard\.js/,
  );
  fs.writeFileSync(path.join(root, "shared", "local-db-guard.js"), "export const guard = 1;\n");
  assertRelativeImportsResolve([root]);
});

test("assertRelativeImportsResolve ignores roots that do not exist", (t) => {
  assertRelativeImportsResolve([path.join(tempDir(t), "missing")]);
});

// The real thing: run scripts/build.mjs against a real dist/ and a real tsc.
// Each case copies the package's build inputs to a scratch package so nothing
// here touches the working tree's own dist/.
function scratchPackage(t) {
  const root = tempDir(t);
  const pkg = path.join(root, "packages", "jinn");
  fs.mkdirSync(path.join(pkg, "src", "shared"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "src", "work-items"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "scripts"));
  for (const file of ["build.mjs", "dist-integrity.mjs"]) {
    fs.copyFileSync(path.join(packageRoot, "scripts", file), path.join(pkg, "scripts", file));
  }
  for (const file of ["tsconfig.json", "tsconfig.build.json"]) {
    fs.copyFileSync(path.join(packageRoot, file), path.join(pkg, file));
  }
  fs.copyFileSync(path.join(packageRoot, "../../tsconfig.base.json"), path.join(root, "tsconfig.base.json"));
  fs.writeFileSync(path.join(pkg, "src", "shared", "local-db-guard.ts"), "export const guard = 1;\n");
  fs.writeFileSync(path.join(pkg, "src", "work-items", "migrate.ts"), 'import { guard } from "../shared/local-db-guard.js";\nexport const migrate = guard;\n');
  fs.writeFileSync(path.join(pkg, "bin", "jinn.ts"), 'import { migrate } from "../src/work-items/migrate.js";\nconsole.log(migrate);\n');
  // The scratch build resolves typescript and the gateway-events package like the real one.
  fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(pkg, "node_modules"), "dir");
  const events = path.join(root, "packages", "gateway-events");
  fs.mkdirSync(path.join(events, "src"), { recursive: true });
  fs.copyFileSync(path.join(packageRoot, "../gateway-events/tsconfig.json"), path.join(events, "tsconfig.json"));
  fs.writeFileSync(path.join(events, "src", "index.ts"), "export const event = 1;\n");
  return pkg;
}

function runBuild(pkg) {
  return spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: pkg, encoding: "utf8" });
}

test("a real build over a dist/ left half-removed by an earlier run is complete", (t) => {
  const pkg = scratchPackage(t);
  const first = runBuild(pkg);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const guard = path.join(pkg, "dist", "src", "shared", "local-db-guard.js");
  assert.ok(fs.existsSync(guard));
  // The state a failed clean leaves: the importer survives, its dependency does not.
  fs.rmSync(guard);
  fs.rmSync(path.join(pkg, "dist", "src", "shared", "local-db-guard.d.ts"));
  const second = runBuild(pkg);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.ok(fs.existsSync(guard), "a rebuild re-emits what a partial clean left missing");
});

test("a real build exits nonzero, and does not compile, when dist/src cannot be removed", { skip: process.platform === "win32" || process.getuid?.() === 0 }, (t) => {
  const pkg = scratchPackage(t);
  assert.equal(runBuild(pkg).status, 0);
  const shared = path.join(pkg, "dist", "src", "shared");
  // A directory whose entries cannot be unlinked: the removal fails part-way.
  fs.chmodSync(shared, 0o555);
  try {
    const migrate = path.join(pkg, "dist", "src", "work-items", "migrate.js");
    const failure = runBuild(pkg);
    assert.notEqual(failure.status, 0, `${failure.stdout}\n${failure.stderr}`);
    assert.match(failure.stderr, /EACCES/);
    assert.doesNotMatch(failure.stdout, /build: compiled to dist/);
    // The removal got part-way (the sibling directory is gone, the protected one is not)
    // and the build stopped there rather than recompiling over what was left.
    assert.ok(fs.existsSync(path.join(shared, "local-db-guard.js")));
    assert.equal(fs.existsSync(migrate), false, "nothing was compiled over the partial tree");
  } finally {
    fs.chmodSync(shared, 0o755);
  }
});
