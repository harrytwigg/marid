#!/usr/bin/env node
// The incidents this repo keeps re-living, as a check. Every rule below is
// something that actually broke: a personal path published to npm, a sandbox
// served on the production port, a home derived from a literal that ignored
// JINN_HOME, an env read that drifted away from the config layer, a spawn whose
// unread pipe deadlocked once the child filled it.
//
// The gate is diff-scoped on purpose. Tree-wide these rules match hundreds of
// pre-existing lines, and a check that opens red on every run is a check nobody
// reads. CI judges only the lines a change ADDS, so no baseline file is needed
// and existing debt never blocks a merge. `--all` is the local audit that prints
// that debt.
//
// Suppress one line with `// footgun: ok <reason>` (or `# footgun: ok <reason>`
// in YAML and shell). A suppression with no reason still suppresses, but the run
// lists it as unaudited — otherwise `git grep 'footgun: ok'` stops being worth
// reading, which is the only thing that makes inline suppression safe.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

import { RAW_BACKDROP_BLUR } from "./footguns/backdrop-blur.mjs"
import { findLeaks, loadPrivateTerms, PRIVATE_TERMS_DEFAULT } from "./footguns/privacy-leak.mjs"
import { REMOVED_UI_LIBRARY } from "./footguns/removed-ui-libraries.mjs"

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const TEXT_EXTENSIONS = new Set([...CODE_EXTENSIONS, ".json", ".md", ".yml", ".yaml", ".sh"])

// Shipped release artifacts. The paths in them record what an older version
// wrote to a machine and cannot be edited retroactively, so personal-path
// exempts them rather than teaching contributors to ignore the checker. Only
// that rule: a real address published in a migration is a live leak no matter
// which version wrote it, and every other rule reads a file that still runs.
const FROZEN_MIGRATIONS = /^packages\/[^/]+\/template\/migrations\//

// The rules cannot be written, tested or explained without spelling out every
// pattern they detect, so the three files that do that are exempt from them.
const DESCRIBES_THE_RULES = new Set([
  "scripts/check-footguns.mjs",
  "scripts/__tests__/check-footguns.test.mjs",
  ".github/CONTRIBUTING.md",
])

const SUPPRESSION = /(?:\/\/|#)\s*footgun:\s*ok\b[ \t]*(.*)$/

/** Lines matching `pattern`, minus the ones `ignore` recognises as a sanctioned idiom. */
function matchingLines(text, pattern, ignore) {
  const found = []
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) continue
    if (ignore && ignore(lines[index])) continue
    found.push(index + 1)
  }
  return found
}

function extensionIn(relPath, extensions) {
  return extensions.has(path.extname(relPath))
}

const underPackages = (relPath) => relPath.startsWith("packages/")

function isTest(relPath) {
  return relPath.includes("/__tests__/") || /\.test\.[jt]sx?$/.test(relPath)
}

const RULES = [
  RAW_BACKDROP_BLUR,
  REMOVED_UI_LIBRARY,
  {
    name: "personal-path",
    message: "an absolute /Users/ path — this repo is published to npm, and the path names its author's machine",
    fix: "Derive the path at runtime — resolveJinnHome(), os.homedir(), or mkdtempSync(os.tmpdir()) in a fixture — or write a neutral placeholder.",
    scans: (relPath) => extensionIn(relPath, TEXT_EXTENSIONS) && !FROZEN_MIGRATIONS.test(relPath),
    find: (text) => matchingLines(text, /\/Users\//),
  },
  {
    name: "hardcoded-home",
    message: "a .jinn home built from the user's home directory — it ignores JINN_HOME and JINN_INSTANCE, so it reads the wrong instance",
    fix: "Call resolveJinnHome() from src/shared/home.ts, which honours JINN_HOME first and JINN_INSTANCE second.",
    allow: new Set([
      "packages/jinn/src/shared/home.ts",
      "packages/jinn/src/shared/paths.ts",
      "packages/jinn/src/instances/directory.ts",
    ]),
    scans: (relPath) => underPackages(relPath) && extensionIn(relPath, CODE_EXTENSIONS),
    // Both halves must be on one line: the home call, and a literal that names a
    // `.jinn` directory. Other tools' homes (".codex", ".grok", ".gemini") are
    // ours to hardcode — they are those tools' contracts, not our instance root.
    find: (text) =>
      matchingLines(
        text,
        /(?:(?:os\.)?homedir\(\)|process\.env\.(?:HOME|USERPROFILE))[^\n]*["'`]\.jinn[\w-]*["'`]/,
      ),
  },
  {
    name: "privacy-leak",
    message: "an email address on a real domain, or a term from the private-terms file — everything here is public and ships to npm",
    fix: "Use an illustrative address (someone@example.com) or a neutral placeholder. Anything that must be personal is read at runtime from the instance home, never committed.",
    scans: (relPath) => extensionIn(relPath, TEXT_EXTENSIONS),
    find: (text, relPath, context) => findLeaks(text, relPath, context.privateTerms),
  },
  {
    name: "hardcoded-port",
    message: "a literal gateway port — 7777 is the production gateway and 7788 the operator's demo instance, and whatever owns that port gets killed by the lifecycle",
    fix: "Read the port from the loaded config or take it as a parameter. DEFAULT_CONFIG in src/cli/setup.ts is the one place the literal belongs.",
    allow: new Set([
      "packages/jinn/src/shared/config.ts",
      "packages/jinn/src/cli/setup.ts",
      "packages/jinn/src/instances/directory.ts",
      "packages/jinn/src/instances/create.ts",
      "packages/web/vite.config.ts",
    ]),
    scans: (relPath) => underPackages(relPath) && extensionIn(relPath, CODE_EXTENSIONS),
    find: (text) => matchingLines(text, /\b(?:7777|7788)\b/),
  },
  {
    name: "scattered-env",
    // Scoped to packages/*/src: the CLI entry, the Vitest harness and the Vite
    // config all read env by definition, and tests set JINN_HOME to isolate
    // themselves, which is the behaviour we want rather than a footgun.
    message: "a process.env read outside the config layer — env handling spread across modules is how JINN_HOME drifts between the gateway and the children it spawns",
    fix: "Read it through loadConfig() or resolveJinnHome(), or thread it in as a parameter (`env: NodeJS.ProcessEnv = process.env`) so a caller can override it.",
    allow: new Set([
      "packages/jinn/src/shared/config.ts",
      "packages/jinn/src/shared/home.ts",
      "packages/jinn/src/shared/paths.ts",
      "packages/jinn/src/shared/child-env.ts",
      "packages/jinn/src/mcp/env-scrub.ts",
      "packages/jinn/src/mcp/scrub-entry.ts",
      "packages/jinn/src/mcp/server-entry.ts",
      "packages/jinn/src/cli/container-contract.ts",
    ]),
    scans: (relPath) =>
      /^packages\/[^/]+\/src\//.test(relPath) && extensionIn(relPath, CODE_EXTENSIONS) && !isTest(relPath),
    // The two deliberate seams are the opposite of scattered env: they name
    // process.env once, at the boundary, so every other line can be overridden.
    find: (text) =>
      matchingLines(
        text,
        /process\.env\b/,
        (line) => /:\s*NodeJS\.ProcessEnv\s*=\s*process\.env\b/.test(line) || /buildEngineChildEnv\(\s*process\.env\b/.test(line),
      ),
  },
  {
    name: "spawn-without-stdio",
    message: "a child_process spawn with no explicit stdio — the default pipes stdout and stderr, and an unread pipe deadlocks the child once its buffer fills",
    fix: "Pass stdio explicitly in the options object: \"ignore\" when the output is unwanted, \"inherit\" to pass it through, or an array to pick per stream.",
    scans: (relPath) => underPackages(relPath) && extensionIn(relPath, CODE_EXTENSIONS),
    find: (text, relPath, context) => findSpawnsWithoutStdio(text, relPath, context),
  },
]

// Only these. Async exec/execFile accept no stdio option at all, so flagging
// them produces findings that cannot be fixed — which is the whole reason this
// rule reads the AST instead of grepping for `spawn(`.
const SPAWN_CALLS = new Set(["spawn", "spawnSync", "execSync", "execFileSync", "fork"])

const CHILD_PROCESS_MODULE = /^(?:node:)?child_process$/

function scriptKindFor(ts, relPath) {
  switch (path.extname(relPath)) {
    case ".tsx":
      return ts.ScriptKind.TSX
    case ".ts":
      return ts.ScriptKind.TS
    case ".jsx":
      return ts.ScriptKind.JSX
    default:
      return ts.ScriptKind.JS
  }
}

/**
 * The names in this file that actually refer to child_process. Without this,
 * `pty.spawn` (node-pty, which has no stdio option), `this.spawn` and
 * `RE.exec` all look like the real thing.
 */
function collectChildProcessBindings(ts, source) {
  const direct = new Set()
  const namespaces = new Set()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!CHILD_PROCESS_MODULE.test(statement.moduleSpecifier.text)) continue
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) namespaces.add(clause.name.text)
    const bindings = clause.namedBindings
    if (!bindings) continue
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    else for (const element of bindings.elements) direct.add(element.name.text)
  }
  return { direct, namespaces }
}

function isSpawnCall(ts, call, bindings) {
  const callee = call.expression
  if (ts.isIdentifier(callee)) {
    return SPAWN_CALLS.has(callee.text) && bindings.direct.has(callee.text)
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return SPAWN_CALLS.has(callee.name.text) && bindings.namespaces.has(callee.expression.text)
  }
  return false
}

/**
 * Undecidable rather than missing: an options object built elsewhere, or spread
 * from a base, may well carry stdio. Reporting those would cost a suppression on
 * every legitimate helper, so they pass. What cannot carry options at all — a
 * lone command, or a trailing argument list — is a genuine miss.
 */
function declaresStdio(ts, call) {
  if (call.arguments.length <= 1) return false
  const options = call.arguments[call.arguments.length - 1]
  if (!ts.isObjectLiteralExpression(options)) {
    return !ts.isStringLiteralLike(options) && !ts.isArrayLiteralExpression(options) && !ts.isTemplateExpression(options)
  }
  return options.properties.some(
    (property) =>
      ts.isSpreadAssignment(property) ||
      (property.name !== undefined &&
        (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
        property.name.text === "stdio"),
  )
}

function findSpawnsWithoutStdio(text, relPath, context) {
  // Parsing every file in the tree costs seconds; almost none of them mention a
  // spawn at all.
  if (![...SPAWN_CALLS].some((name) => text.includes(name))) return []
  const ts = context.typescript
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, relPath))
  const bindings = collectChildProcessBindings(ts, source)
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return []

  const found = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && isSpawnCall(ts, node, bindings) && !declaresStdio(ts, node)) {
      found.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

function git(...args) {
  // quotePath off so a path with a non-ASCII character arrives as itself rather
  // than as an escape sequence no rule would ever match.
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function trackedFiles() {
  return git("ls-files").split("\n").filter(Boolean)
}

/**
 * Added lines only, keyed by path. `-U0` leaves the patch with nothing but hunk
 * headers and changed lines, so the new-file line number is just a counter that
 * `+` advances and `-` does not. The header is only read between `diff --git`
 * and the first hunk, so an added line that itself begins with `+++` cannot be
 * mistaken for one.
 */
function addedLines(diff) {
  const byFile = new Map()
  let lines = null
  let inHeader = false
  let lineNumber = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      lines = null
      inHeader = true
      continue
    }
    if (inHeader) {
      if (!line.startsWith("+++ ")) continue
      inHeader = false
      const target = line.slice(4)
      if (target === "/dev/null") continue
      lines = new Set()
      byFile.set(target.replace(/^b\//, ""), lines)
      continue
    }
    if (line.startsWith("@@")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
      if (hunk) lineNumber = Number(hunk[1])
      continue
    }
    if (lines && line.startsWith("+")) {
      lines.add(lineNumber)
      lineNumber += 1
    }
  }
  return byFile
}

function diffTarget(mode, ref) {
  if (mode === "staged") {
    return { diff: git("diff", "--cached", "-U0"), read: (file) => git("show", `:${file}`) }
  }
  const merged = git("merge-base", ref, "HEAD").trim()
  return { diff: git("diff", "-U0", merged, "HEAD"), read: (file) => readFileSync(file, "utf8") }
}

function selectFiles(mode, ref) {
  if (mode === "all") {
    return { files: trackedFiles().map((file) => ({ file, lines: null })), read: (file) => readFileSync(file, "utf8") }
  }
  const { diff, read } = diffTarget(mode, ref)
  const files = [...addedLines(diff)]
    .filter(([, lines]) => lines.size > 0)
    .map(([file, lines]) => ({ file, lines }))
  return { files, read }
}

function loadTypeScript() {
  return import("typescript").then(
    (module) => module.default,
    () => {
      throw new Error(
        "The spawn-without-stdio rule parses TypeScript and the `typescript` package is not resolvable. Run `pnpm install`.",
      )
    },
  )
}

function ruleApplies(rule, relPath) {
  if (DESCRIBES_THE_RULES.has(relPath)) return false
  if (rule.allow?.has(relPath)) return false
  return rule.scans(relPath)
}

function inspect({ file, lines }, text, context) {
  const sourceLines = text.split("\n")
  const violations = []
  const suppressions = []
  for (const rule of RULES) {
    if (!ruleApplies(rule, file)) continue
    for (const line of rule.find(text, file, context)) {
      if (lines && !lines.has(line)) continue
      const suppression = SUPPRESSION.exec(sourceLines[line - 1] ?? "")
      if (suppression) suppressions.push({ file, line, rule, audited: suppression[1].trim().length > 0 })
      else violations.push({ file, line, rule })
    }
  }
  return { violations, suppressions }
}

function report(violations, suppressions, scanned, privateTerms) {
  for (const { file, line, rule } of violations) {
    console.log(`${file}:${line}`)
    console.log(`  ${rule.name}: ${rule.message}`)
    console.log(`  fix: ${rule.fix}`)
    console.log("")
  }

  const unaudited = suppressions.filter((suppression) => !suppression.audited)
  if (unaudited.length > 0) {
    console.log("Unaudited suppressions — write the reason after `footgun: ok`:")
    for (const { file, line, rule } of unaudited) console.log(`  ${file}:${line}  ${rule.name}`)
    console.log("")
  }

  const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`
  console.log(
    `footguns: ${plural(violations.length, "violation")} in ${plural(scanned, "file")}, ` +
      `${plural(suppressions.length, "suppression")} (${unaudited.length} unaudited)`,
  )
  if (privateTerms.length === 0) {
    console.log(`privacy-leak ran structurally only — no private-terms file at ${PRIVATE_TERMS_DEFAULT}.`)
  }
}

function listRules() {
  for (const rule of RULES) {
    console.log(rule.name)
    console.log(`  ${rule.message}`)
    console.log(`  fix: ${rule.fix}`)
    console.log("")
  }
}

function parseArgs(argv) {
  if (argv.includes("--list")) return { mode: "list" }
  if (argv.includes("--all")) return { mode: "all" }
  if (argv.includes("--staged")) return { mode: "staged" }
  const diff = argv.indexOf("--diff")
  const ref = diff >= 0 ? argv[diff + 1] : undefined
  return { mode: "diff", ref: ref && !ref.startsWith("--") ? ref : "origin/main" }
}

async function main() {
  const { mode, ref } = parseArgs(process.argv.slice(2))
  if (mode === "list") {
    listRules()
    return 0
  }

  // Git reports paths from the repository root, and every rule scopes on those
  // paths, so the run has to read files from there too.
  process.chdir(git("rev-parse", "--show-toplevel").trim())

  const context = { privateTerms: loadPrivateTerms(), typescript: await loadTypeScript() }
  const { files, read } = selectFiles(mode, ref)

  const violations = []
  const suppressions = []
  let scanned = 0
  for (const candidate of files) {
    if (!RULES.some((rule) => ruleApplies(rule, candidate.file))) continue
    let text
    try {
      text = read(candidate.file)
    } catch (error) {
      // Tracked but not on disk — deleted in the working tree, or added by the
      // diff and removed by a later commit. Neither is this run's problem.
      if (error.code === "ENOENT") continue
      throw error
    }
    scanned += 1
    const found = inspect(candidate, text, context)
    violations.push(...found.violations)
    suppressions.push(...found.suppressions)
  }

  report(violations, suppressions, scanned, context.privateTerms)
  return violations.length > 0 ? 1 : 0
}

process.exitCode = await main()
