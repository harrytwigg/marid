/**
 * Test-only preload (`node --import`) that injects the failures scripts/build.mjs
 * has to survive or refuse, so the tests can drive the real build end to end.
 * It only acts inside build.mjs (the tsc child inherits NODE_OPTIONS and must
 * be left alone) and is selected by BUILD_FAULT:
 *
 *   rm-transient   removing dist/src throws ENOTEMPTY twice, then works
 *   rm-always      removing dist/src always throws ENOTEMPTY
 *   rm-noop        removing dist/src silently does nothing
 *   emitted-gone   a compiled file is deleted after tsc, before the build ends
 *   import-dangles a compiled file appears that imports a module that does not exist
 */
import fs from "node:fs";
import path from "node:path";

const fault = process.env.BUILD_FAULT;
if (fault && path.basename(process.argv[1] ?? "") === "build.mjs") {
  const isDistSrc = (target) => path.basename(String(target)) === "src" && path.basename(path.dirname(String(target))) === "dist";
  const realRm = fs.rmSync;
  let rmCalls = 0;
  fs.rmSync = (target, options) => {
    if (!isDistSrc(target)) return realRm(target, options);
    rmCalls += 1;
    if (fault === "rm-always" || (fault === "rm-transient" && rmCalls <= 2)) {
      throw Object.assign(new Error(`ENOTEMPTY, Directory not empty: ${target}`), { code: "ENOTEMPTY" });
    }
    if (fault === "rm-noop") return undefined;
    return realRm(target, options);
  };

  // Step 5 of the build makes dist/src/talk once tsc and the protocol embedding are done.
  const realMkdir = fs.mkdirSync;
  fs.mkdirSync = (target, options) => {
    const result = realMkdir(target, options);
    if (path.basename(String(target)) === "talk" && path.basename(path.dirname(String(target))) === "src") {
      const shared = path.join(path.dirname(String(target)), "shared");
      if (fault === "emitted-gone") realRm(path.join(shared, "local-db-guard.js"), { force: true });
      if (fault === "import-dangles") fs.writeFileSync(path.join(shared, "stray.js"), 'import "./ghost.js";\n');
    }
    return result;
  };
}
