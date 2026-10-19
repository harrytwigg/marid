import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// Spawned with a temp repository as its cwd, so the path has to be absolute.
const CHECKER = fileURLToPath(new URL("../check-footguns.mjs", import.meta.url))

// Nothing here may depend on the developer's git config or on a private
// terms file that happens to exist on this machine.
/** @type {NodeJS.ProcessEnv} */
const HERMETIC = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
delete HERMETIC.FOOTGUN_TERMS_FILE

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=footguns", "-c", "user.email=footguns@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: HERMETIC,
  })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function writeFiles(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const target = path.join(root, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
}

/** A repository whose index holds exactly `files`, which is all `--all` reads. */
function repoWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "footguns-"))
  git(root, "init", "-b", "main")
  writeFiles(root, files)
  git(root, "add", "--force", "-A")
  return root
}

function check(cwd, ...args) {
  const result = spawnSync(process.execPath, [CHECKER, ...args], { cwd, encoding: "utf8", env: HERMETIC })
  assert.notEqual(result.status, null, `the checker was killed by ${result.signal}`)
  assert.ok(result.status === 0 || result.status === 1, `unexpected exit ${result.status}: ${result.stderr}`)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function violationsOf(output, rule) {
  return [...output.matchAll(new RegExp(`^ {2}${rule}:`, "gm"))].length
}

function totalViolations(output) {
  const summary = /^footguns: (\d+) violations? /m.exec(output)
  assert.ok(summary, `no summary line in:\n${output}`)
  return Number(summary[1])
}

/**
 * Each rule gets a file that must fire it and a file that must not. The
 * false positives are not hypothetical: every one is an idiom already in the
 * tree that an earlier, grep-shaped version of the rule reported.
 */
const RULE_CASES = [
  {
    rule: "personal-path",
    triggers: {
      "packages/jinn/src/thing.ts": 'export const cache = "/Users/someone/.cache/jinn";\n',
    },
    passes: {
      "packages/jinn/template/migrations/0001-initial/notes.md": "Wrote /Users/someone/.jinn/config.yaml\n",
    },
    passesBecause: "frozen release migrations record what an older version wrote",
  },
  {
    rule: "hardcoded-home",
    triggers: {
      "packages/jinn/src/thing.ts": 'export const home = path.join(os.homedir(), ".jinn");\n',
    },
    passes: {
      "packages/jinn/src/engines/other.ts":
        'export const codex = path.join(os.homedir(), ".codex", "sessions");\n' +
        'export const grok = path.join(os.homedir(), ".grok", "sessions");\n',
    },
    passesBecause: "another tool's home directory is that tool's contract, not our instance root",
  },
  {
    rule: "privacy-leak",
    triggers: { "docs/notes.md": "Reported by dev@acme-widgets.io\n" },
    passes: {
      "docs/illustrative.md": "Reported by someone@example.com\n",
      "packages/shell/AppIcon.appiconset/Contents.json":
        '{"filename":"AppIcon-20x20@2x.png"}\n{"filename":"AppIcon-29x29@2x-1.png"}\n',
    },
    passesBecause: "reserved documentation domains and asset scale suffixes are not personal addresses",
  },
  {
    rule: "hardcoded-port",
    triggers: { "packages/jinn/src/gateway/probe.ts": "const url = `http://127.0.0.1:7777/api/status`;\n" },
    passes: {
      "packages/jinn/src/cli/setup.ts": "const DEFAULT_CONFIG = { gateway: { port: 7777, host: \"127.0.0.1\" } };\n",
    },
    passesBecause: "DEFAULT_CONFIG is where the literal is defined",
  },
  {
    rule: "scattered-env",
    triggers: { "packages/jinn/src/gateway/probe.ts": "const home = process.env.JINN_HOME;\n" },
    passes: {
      "packages/jinn/src/gateway/seam.ts":
        "export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {\n" +
        "  return { ...env };\n}\n",
    },
    passesBecause: "naming process.env once at an overridable seam is the opposite of scattering it",
  },
  {
    rule: "raw-backdrop-blur",
    triggers: {
      "packages/web/src/components/bar.tsx": 'export const Bar = () => <nav className="backdrop-blur-xl" />;\n',
    },
    passes: {
      // The token file owns the material, and a test may name a filter to assert it is gone.
      "packages/web/src/routes/glass-identity.css": ".glass-float { backdrop-filter: var(--glass-blur); }\n",
      "packages/web/src/components/__tests__/bar.test.tsx": 'expect(el.style.backdropFilter).toBe("")\n',
      "packages/jinn/src/gateway/page.ts": 'const css = "backdrop-filter: blur(4px)";\n',
    },
    passesBecause: "the glass token file defines the material, tests assert on it, and only the web app is in scope",
  },
  {
    rule: "removed-ui-library",
    triggers: {
      "packages/web/src/components/menu.tsx": 'import { Slot } from "radix-ui"\n',
    },
    passes: {
      // The look-alikes: the local slot, the icon module, packages that merely start alike, prose that
      // names a library, and another package, where the web app's bundle is not at stake.
      "packages/web/src/components/fine.tsx":
        'import { Slot } from "./slot"\nimport { Search } from "@/components/ui/icon"\n' +
        'import { Command } from "cmdk-like"\nimport { useRadixThing } from "@/hooks/radix-ui-compat"\n',
      "packages/web/docs/notes.md": "Replaced `lucide-react` and `radix-ui`.\n",
      "packages/jinn/src/other.ts": 'import { Search } from "lucide-react"\n',
    },
    passesBecause: "only the web app's code is in scope, and only the exact libraries count",
  },
  {
    rule: "spawn-without-stdio",
    triggers: {
      "packages/jinn/src/download.ts":
        'import { spawn } from "node:child_process";\n' + 'const curl = spawn("curl", ["-L", "-o", target, url]);\n',
    },
    passes: {
      // Each of these would be reported the moment the rule went back to
      // grepping for `spawn(` and `exec(`: the two async calls take no options
      // object here, and node-pty's spawn is given one without stdio.
      "packages/jinn/src/async-calls.ts":
        'import { exec, execFile } from "node:child_process";\n' +
        'import pty from "node-pty";\n' +
        'const term = pty.spawn(bin, args, { cols: 80, rows: 24 });\n' +
        "const ready = /ready/.exec(line);\n" +
        'exec("git log --oneline");\n' +
        'execFile("git", ["status"]);\n',
    },
    passesBecause: "async exec and execFile accept no stdio option, and pty.spawn is not child_process",
  },
]

for (const { rule, triggers, passes, passesBecause } of RULE_CASES) {
  test(`${rule} reports the violation it exists for`, () => {
    const output = check(repoWith(triggers), "--all").stdout
    assert.equal(violationsOf(output, rule), 1, output)
  })

  test(`${rule} stays quiet: ${passesBecause}`, () => {
    // The trigger rides along, so a rule that had stopped matching anything at
    // all could not pass this by staying silent.
    const output = check(repoWith({ ...triggers, ...passes }), "--all").stdout
    assert.equal(violationsOf(output, rule), 1, output)
    for (const file of Object.keys(passes)) {
      assert.doesNotMatch(output, new RegExp(`^${file.replace(/[.]/g, "\\.")}:`, "m"), output)
    }
  })
}

test("removed-ui-library catches every library, in every way a module is named", () => {
  const root = repoWith({
    "packages/web/src/a.tsx": 'import { Slot } from "radix-ui"\n',
    "packages/web/src/b.tsx": 'import * as Dialog from "@radix-ui/react-dialog"\n',
    "packages/web/src/c.tsx": 'import { Search } from "lucide-react"\n',
    "packages/web/src/d.tsx": "import { Command } from 'cmdk'\n",
    "packages/web/src/e.ts": 'const icons = await import("lucide-react/dynamic")\n',
    "packages/web/src/f.cjs": 'const { Slot } = require("@radix-ui/react-slot")\n',
    "packages/web/package.json": '{\n  "dependencies": {\n    "cmdk": "^1.1.1"\n  }\n}\n',
  })

  const { status, stdout } = check(root, "--all")

  assert.equal(violationsOf(stdout, "removed-ui-library"), 7, stdout)
  assert.equal(status, 1)
})

test("removed-ui-library judges only the lines a change adds", () => {
  const root = repoWith({ "packages/web/src/old.tsx": 'import { Search } from "lucide-react"\n' })
  git(root, "commit", "-m", "base")
  git(root, "branch", "base")
  writeFiles(root, { "packages/web/src/new.tsx": 'import { Slot } from "radix-ui"\n' })
  git(root, "add", "-A")
  git(root, "commit", "-m", "change")

  const { stdout } = check(root, "--diff", "base")

  assert.equal(violationsOf(stdout, "removed-ui-library"), 1, stdout)
  assert.match(stdout, /^packages\/web\/src\/new\.tsx:1$/m)
})

test("a frozen migration excuses the historical path, never a live leak", () => {
  const root = repoWith({
    "packages/jinn/template/migrations/0001-initial/notes.md":
      "Wrote /Users/someone/.jinn/config.yaml\nContact dev@acme-widgets.io\n",
  })

  const { status, stdout } = check(root, "--all")
  assert.equal(violationsOf(stdout, "personal-path"), 0, stdout)
  assert.equal(violationsOf(stdout, "privacy-leak"), 1, stdout)
  assert.equal(status, 1)
})

test("--list prints every rule with a remediation", () => {
  const { status, stdout } = check(process.cwd(), "--list")

  assert.equal(status, 0)
  for (const { rule } of RULE_CASES) assert.match(stdout, new RegExp(`^${rule}$`, "m"))

  const fixes = [...stdout.matchAll(/^ {2}fix: (.+)$/gm)].map((match) => match[1].trim())
  assert.equal(fixes.length, RULE_CASES.length)
  for (const fix of fixes) assert.ok(fix.length > 0, "every rule needs a non-empty fix")
})

test("every raw backdrop filter in this repository is the glass file or an explained exception", async () => {
  const { BACKDROP_BLUR_ALLOWLIST, GLASS_TOKEN_FILE } = await import("../footguns/backdrop-blur-allowlist.mjs")
  const tracked = git(process.cwd(), "ls-files", "packages/web/src").split("\n").filter(Boolean)
  const raw = /backdrop-filter|backdropFilter|\bbackdrop-(?:blur|saturate|brightness|contrast|grayscale|hue-rotate|invert|sepia)\b/
  const holders = tracked.filter(
    (file) => /\.(?:tsx?|css)$/.test(file) && !/\/__tests__\/|\.test\./.test(file) && raw.test(fs.readFileSync(file, "utf8")),
  )

  // An entry for a file that no longer filters is a rotted excuse: drop it.
  for (const file of BACKDROP_BLUR_ALLOWLIST.keys()) {
    assert.ok(holders.includes(file), `${file} is allowlisted but holds no raw backdrop filter; remove the entry`)
  }
  for (const [file, reason] of BACKDROP_BLUR_ALLOWLIST) assert.ok(reason.trim().length > 0, `${file} needs a reason`)
  const unexplained = holders.filter((file) => file !== GLASS_TOKEN_FILE && !BACKDROP_BLUR_ALLOWLIST.has(file))
  assert.deepEqual(unexplained, [])
  assert.match(fs.readFileSync(GLASS_TOKEN_FILE, "utf8"), /backdrop-filter/, "the token file should hold the filter")

  const { stdout } = check(process.cwd(), "--all")
  assert.equal(violationsOf(stdout, "raw-backdrop-blur"), 0, stdout)
})

test("--all completes over this repository without throwing", () => {
  const { stderr } = check(process.cwd(), "--all")
  assert.doesNotMatch(stderr, /at .+:\d+:\d+/, `the run threw:\n${stderr}`)
})

test("the files that describe the rules are excluded from them", () => {
  // Meaningless unless those files really do carry the patterns: a rule that
  // simply never matched them would pass this too.
  for (const file of [CHECKER, path.resolve(".github/CONTRIBUTING.md")]) {
    assert.match(fs.readFileSync(file, "utf8"), /\/Users\//, `${file} should trip personal-path`)
  }

  const { stdout } = check(process.cwd(), "--all")
  assert.doesNotMatch(stdout, /^scripts\/check-footguns\.mjs:/m, stdout)
  assert.doesNotMatch(stdout, /^scripts\/__tests__\/check-footguns\.test\.mjs:/m, stdout)
  assert.doesNotMatch(stdout, /^\.github\/CONTRIBUTING\.md:/m, stdout)
})

test("`footgun: ok <reason>` suppresses across different rules", () => {
  const root = repoWith({
    "packages/jinn/src/thing.ts":
      'export const cache = "/Users/someone/.cache"; // footgun: ok fixture for a path-mangling test\n' +
      "const port = 7777; // footgun: ok asserts the documented default\n",
  })

  const { status, stdout } = check(root, "--all")
  assert.equal(totalViolations(stdout), 0, stdout)
  assert.equal(status, 0)
  assert.match(stdout, /2 suppressions \(0 unaudited\)/)
})

test("a suppression with no reason still suppresses, and is named as unaudited", () => {
  const root = repoWith({ "packages/jinn/src/thing.ts": 'export const cache = "/Users/someone"; // footgun: ok\n' })

  const { status, stdout } = check(root, "--all")
  assert.equal(totalViolations(stdout), 0, stdout)
  assert.equal(status, 0)
  assert.match(stdout, /1 suppression \(1 unaudited\)/)
  assert.match(stdout, /^ {2}packages\/jinn\/src\/thing\.ts:1 {2}personal-path$/m)
})

test("diff mode judges added lines only, never the debt already in the file", () => {
  const existing =
    'const a = "/Users/someone/one";\nconst b = "/Users/someone/two";\nconst c = "/Users/someone/three";\n'
  const root = repoWith({ "packages/jinn/src/thing.ts": existing })
  git(root, "commit", "-m", "existing debt")
  git(root, "checkout", "-b", "feature")
  fs.writeFileSync(path.join(root, "packages/jinn/src/thing.ts"), `${existing}const d = "/Users/someone/four";\n`)
  git(root, "commit", "--all", "-m", "one more")

  const diffRun = check(root, "--diff", "main")
  assert.equal(totalViolations(diffRun.stdout), 1, diffRun.stdout)
  assert.equal(diffRun.status, 1)
  assert.match(diffRun.stdout, /^packages\/jinn\/src\/thing\.ts:4$/m)

  // The three it ignored are violations, not lines the rule simply misses.
  assert.equal(totalViolations(check(root, "--all").stdout), 4)
})

test("private terms load from outside the repository, never from inside it", () => {
  const root = repoWith({ "docs/notes.md": "Delivered for Acme Widgets this week.\n" })
  const termsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "footgun-terms-")), "terms")
  fs.writeFileSync(termsFile, "# one term per line\nacme widgets\n")

  const result = spawnSync(process.execPath, [CHECKER, "--all"], {
    cwd: root,
    encoding: "utf8",
    env: { ...HERMETIC, FOOTGUN_TERMS_FILE: termsFile },
  })
  assert.equal(violationsOf(result.stdout, "privacy-leak"), 1, result.stdout)
  assert.equal(violationsOf(check(root, "--all").stdout, "privacy-leak"), 0, "structural-only without the terms file")
})

test("a lockfile's addresses come from the registry, though a private term in one is still ours", () => {
  const root = repoWith({
    "pnpm-lock.yaml":
      "  glob@11.1.0:\n" +
      "    deprecated: Support may be purchased by contacting maintainer@acme-widgets.io\n" +
      "  '@private-org/toolkit@1.0.0':\n",
  })
  assert.equal(violationsOf(check(root, "--all").stdout, "privacy-leak"), 0, "npm wrote that address, not us")

  const termsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "footgun-terms-")), "terms")
  fs.writeFileSync(termsFile, "private-org\n")
  const withTerms = spawnSync(process.execPath, [CHECKER, "--all"], {
    cwd: root,
    encoding: "utf8",
    env: { ...HERMETIC, FOOTGUN_TERMS_FILE: termsFile },
  })
  assert.equal(violationsOf(withTerms.stdout, "privacy-leak"), 1, withTerms.stdout)
})

test("pnpm footguns runs the checker", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"))
  assert.match(pkg.scripts.footguns, /scripts\/check-footguns\.mjs/)
})

test("CI runs the checker over the diff, and these tests ride the repository's node:test list", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8")

  const job = /^ {2}footguns:\n(?: {4}.*\n| *\n)*/m.exec(workflow)
  assert.ok(job, "ci.yml must define a footguns job")

  // Without the full history there is no merge base, and the checker would
  // judge the whole tree instead of the change.
  assert.match(job[0], /fetch-depth: 0/)
  assert.match(job[0], /check-footguns\.mjs/)

  // The job runs the checker and nothing else. These tests are run the way
  // every other node:test file here is, rather than by a second mechanism.
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"))
  assert.match(pkg.scripts["test:node"], /scripts\/__tests__\/check-footguns\.test\.mjs/)
  assert.match(pkg.scripts.test, /pnpm test:node/)
})
