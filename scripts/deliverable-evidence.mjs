#!/usr/bin/env node
// Evidence for a Todo whose deliverable lands in the operator's workspace rather
// than in this repository — a knowledge Note, a skill, an org file.
//
// The verifier does not read that workspace, and that rule is the point rather
// than an obstacle: a build-pipeline actor with standing reach into the live
// instance home would hold its tokens, session history and secrets within range
// of every run. So the implementer, which already has that access, leaves a
// manifest here naming each delivered file with its SHA-256, and the verifier
// confirms identity and size from the manifest alone. The operator, who can see
// both sides, re-checks the hashes at the land approval.
//
// `write` is the implementer's half and the only half that touches the
// workspace. `check` is the verifier's half and opens nothing but the manifest
// it is handed, so ruling on a workspace deliverable costs no new read reach.
//
// `route` is the pipeline's half, and it rules on one thing: whether the
// workspace route was declared honestly. A caller passing
// `--declared workspace` gives a hint this pipeline validates, never an
// instruction it obeys — taken on trust, a self-declared workspace route is a
// way to route around code review: declare `workspace`, skip the code check. So
// the route is honoured only when the product diff is empty or confined to
// non-shipping paths, and a mismatch fails loudly rather than silently
// downgrading to ordinary verification.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const MANIFEST_DEFAULT = ".jinn-build/deliverable-evidence.json"
const SHA256 = /^[0-9a-f]{64}$/

/** A false workspace declaration exits distinctly from `fail`, because the
 *  pipeline has to tell "this declaration is not true" apart from "the tool was
 *  called wrong". */
const ROUTE_MISMATCH_EXIT = 2

/** Non-shipping paths, as an allowlist and deliberately not a denylist of the
 *  shipping ones: a denylist would make every top-level directory added later
 *  silently non-shipping, which is the exact failure this check exists to
 *  prevent. Everything outside these prefixes ships. */
const NON_SHIPPING_PREFIXES = ["docs/", ".jinn-build/"]

/** A git status letter and the score behind it: git scores a rename or copy always, a rewrite at
 *  its option, and nothing else, and the score is a percentage of 000-100. Read as valid on any
 *  letter, `A100` was a status; read unbounded, `R999` was. The scored two name a second path. */
const DIFF_STATUS = /^(?:[ABDTUX]|M(?:0[0-9]{2}|100)?|[CR](?:0[0-9]{2}|100))$/
const RENAME_OR_COPY = /^[RC]/

const USAGE = `usage:
  deliverable-evidence.mjs write --todo <ID> --home <dir> --summary <text> [--manifest <path>] <path>...
  deliverable-evidence.mjs check --todo <ID> [--manifest <path>]
  git diff --name-status -z <base>..HEAD | deliverable-evidence.mjs route --declared <repo|workspace>

manifest defaults to ${MANIFEST_DEFAULT}. Delivered paths are relative to --home.`

function fail(reason) {
  console.error(`deliverable evidence FAILED — ${reason}`)
  process.exit(1)
}

/** Separators normalised so one spelling of a path is checked, recorded and printed. */
function toPosix(value) {
  return value.split(path.sep).join("/")
}

function isSecret(posixPath) {
  return posixPath === "secrets" || posixPath.startsWith("secrets/")
}

/** Collapsed before it is judged, so `./packages/x` and `packages/x` are one
 *  path and only one of the two spellings has to match a prefix. */
function isShipping(changedPath) {
  const normalized = path.posix.normalize(toPosix(changedPath))
  return !NON_SHIPPING_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/** Every path the diff touches, on both sides of a rename, from the stream
 *  `git diff --name-status -z` writes: NUL-terminated fields, a status then its
 *  path, or the two a rename moves between. NUL is the one byte a filename
 *  cannot hold, so a status is known by where it sits, never by looking like a
 *  letter — guessing dropped a file named `M` and split a path holding a space,
 *  waving both shipping diffs through as `workspace`. `-z` also writes paths
 *  raw, so git's `"caf\303\251"` quoting never arrives to be undone. */
function changedPaths(stream) {
  const fields = stream.split("\0")
  if (fields[fields.length - 1] === "") fields.pop()
  const paths = []
  for (let i = 0; i < fields.length; ) {
    const status = fields[i]
    if (!DIFF_STATUS.test(status)) fail(`${JSON.stringify(status)} is not a git status: pipe \`git diff --name-status -z\` in unaltered\n\n${USAGE}`)
    const expected = RENAME_OR_COPY.test(status) ? 2 : 1
    const named = fields.slice(i + 1, i + 1 + expected)
    // Refused, not counted short: a truncated diff read as an empty one is how a shipping change passes as workspace.
    if (named.length < expected || named.includes("")) fail(`the stream ends after the status ${status} with no path behind it: the diff is truncated, not empty\n\n${USAGE}`)
    paths.push(...named)
    i += 1 + expected
  }
  return paths
}

function parseArgs(argv) {
  const options = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) fail(`${arg} needs a value\n\n${USAGE}`)
    options[arg.slice(2)] = value
    i += 1
  }
  return { options, positional }
}

function required(options, name) {
  const value = options[name]
  if (typeof value !== "string" || !value.trim()) fail(`--${name} is required\n\n${USAGE}`)
  return value.trim()
}

/** Hash one delivered file, refusing anything that is not plainly inside the home.
 *  Judged on the file the reader will actually open, not on how it was spelled:
 *  a link named in the home resolves to its target first, so `secrets/` cannot be
 *  reached under an innocent name. */
function entryFor(given, homeRoot) {
  if (toPosix(given).split("/").includes("..")) {
    fail(`${given} walks out of the home with "..": name the delivered file by its path under --home`)
  }
  const named = path.resolve(homeRoot, given)
  // A link is judged by the file it points at, so `secrets/` cannot be reached
  // under an innocent name. A path with nothing behind it is judged as spelled
  // and the read below reports that it is not there.
  const absolute = fs.existsSync(named) ? fs.realpathSync(named) : named
  const relative = toPosix(path.relative(homeRoot, absolute))
  if (relative === "" || relative.startsWith("../")) {
    fail(`${given} resolves outside ${homeRoot}: only a file delivered into the home can be evidenced`)
  }
  if (isSecret(relative)) {
    fail(`${given} resolves to ${relative}, which is under secrets/: a secret is never hashed, named or evidenced here`)
  }
  let contents
  try {
    contents = fs.readFileSync(absolute)
  } catch (error) {
    if (error.code === "ENOENT") fail(`${given} does not exist under ${homeRoot}: nothing was delivered there`)
    if (error.code === "EISDIR") fail(`${given} is a directory: evidence names files, one per delivered artifact`)
    throw error
  }
  return {
    path: relative,
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.byteLength,
  }
}

function describe(entries) {
  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  return `${entries.length} ${entries.length === 1 ? "file" : "files"}, ${bytes} bytes`
}

function report(entries) {
  for (const entry of entries) console.log(`  ${entry.path}  ${entry.sha256}  ${entry.bytes} bytes`)
}

function write({ options, positional }) {
  const todoId = required(options, "todo")
  const summary = required(options, "summary")
  // Resolved too, so that comparing a resolved file against it is a comparison
  // of like with like — `/tmp` is a link to `/private/tmp` on macOS.
  const givenHome = path.resolve(required(options, "home"))
  if (!fs.existsSync(givenHome)) fail(`--home ${givenHome} does not exist: name the instance home the files were delivered into`)
  const homeRoot = fs.realpathSync(givenHome)
  const manifestPath = options.manifest ?? MANIFEST_DEFAULT
  if (positional.length === 0) fail(`write needs at least one delivered path\n\n${USAGE}`)

  // Every path is checked before anything is written, so a refused run leaves no
  // half-built manifest for the verifier to read as complete evidence.
  const entries = positional.map((given) => entryFor(given, homeRoot))

  fs.mkdirSync(path.dirname(path.resolve(manifestPath)), { recursive: true })
  fs.writeFileSync(manifestPath, `${JSON.stringify({ todoId, summary, entries }, null, 2)}\n`)

  console.log(`deliverable evidence written — ${todoId}, ${describe(entries)}`)
  console.log(`  ${summary}`)
  report(entries)
}

/** Why a manifest path cannot be evidence, or undefined when it can. */
function pathReason(given, manifestPath) {
  if (typeof given !== "string" || !given.trim()) return `${manifestPath} has an entry with no path`
  // Collapsed before it is judged: `./secrets/x` and `secrets/x` name one file,
  // and only one of the two spellings looked like a secret to a prefix test.
  const normalized = path.posix.normalize(toPosix(given))
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return `${manifestPath} names ${given}, which is not a path under the home`
  }
  if (isSecret(normalized)) return `${manifestPath} names ${given}, which is under secrets/: a secret is never evidenced`
  return undefined
}

function validateEntry(entry, manifestPath) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`${manifestPath} has an entry that is not a JSON object`)
  }
  const reason = pathReason(entry.path, manifestPath)
  if (reason) fail(reason)
  if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
    fail(`${manifestPath} gives ${entry.path} the hash ${JSON.stringify(entry.sha256)}, which is not 64 lowercase hex characters`)
  }
  if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
    fail(`${manifestPath} gives ${entry.path} the size ${JSON.stringify(entry.bytes)}, which is not a whole number of bytes`)
  }
}

/** The manifest — the only file this half of the tool opens. */
function readManifest(manifestPath) {
  let raw
  try {
    raw = fs.readFileSync(manifestPath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(`no manifest at ${manifestPath}: a workspace deliverable is evidenced by \`deliverable-evidence.mjs write\`, and without it there is nothing here to rule on`)
    }
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    return fail(`${manifestPath} is not valid JSON: ${error.message}`)
  }
}

/** Why the manifest as a whole cannot be read as evidence for `todoId`. */
function manifestReason(record, todoId, manifestPath) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return `${manifestPath} is not a JSON object`
  if (record.todoId !== todoId) {
    return `${manifestPath} evidences ${JSON.stringify(record.todoId)}, not ${todoId}: this manifest belongs to another Todo`
  }
  if (!Array.isArray(record.entries) || record.entries.length === 0) {
    return `${manifestPath} lists no entries: a workspace deliverable evidences at least one delivered file`
  }
  return undefined
}

function check({ options }) {
  const todoId = required(options, "todo")
  const manifestPath = options.manifest ?? MANIFEST_DEFAULT
  const record = readManifest(manifestPath)

  const reason = manifestReason(record, todoId, manifestPath)
  if (reason) fail(reason)
  for (const entry of record.entries) validateEntry(entry, manifestPath)

  // Deliberately no stat, no read, no existence check on any entry path. The
  // verdict is about what the manifest attests, which is all this side can see.
  console.log(`deliverable evidence OK — ${todoId}, ${describe(record.entries)}`)
  if (record.summary) console.log(`  ${record.summary}`)
  report(record.entries)
}

/** Path arithmetic over the stream it is handed, and nothing else: no file of
 *  the diff is opened, nothing is stat'd, no git is run. That is what keeps the
 *  ruling unit-testable and this command out of the tree it is judging. */
function route({ options, positional }) {
  // Only on stdin: paths as arguments would have to be split on whitespace,
  // and splitting is the hole.
  if (positional.length > 0) fail(`route reads the diff on stdin, not as arguments: pipe \`git diff --name-status -z <base>..HEAD\` into it\n\n${USAGE}`)
  const declared = required(options, "declared")
  if (declared !== "repo" && declared !== "workspace") {
    fail(`--declared ${JSON.stringify(declared)} is neither repo nor workspace\n\n${USAGE}`)
  }
  if (declared === "repo") {
    console.log("deliverable route OK — repo, the diff is verified as usual")
    return
  }

  // Rather than block on a terminal waiting for a diff nobody is going to type.
  if (process.stdin.isTTY) fail(`route reads the diff on stdin: pipe \`git diff --name-status -z <base>..HEAD\` into it\n\n${USAGE}`)
  const changed = changedPaths(fs.readFileSync(0, "utf8"))
  const shipping = changed.filter(isShipping)
  if (shipping.length > 0) {
    console.error(`deliverable route FAILED — the route was declared "workspace", but the diff changes ${shipping.length === 1 ? "a shipping file" : "shipping files"}:`)
    for (const changed of shipping) console.error(`  ${changed}`)
    console.error("a workspace declaration is a hint, never an instruction: work carrying real source changes is verified on the normal route. Drop the declaration, or drop the source changes.")
    process.exit(ROUTE_MISMATCH_EXIT)
  }

  console.log(`deliverable route OK — workspace, ${changed.length} changed ${changed.length === 1 ? "path" : "paths"}, none of them shipping`)
}

const [command, ...rest] = process.argv.slice(2)
const parsed = parseArgs(rest)
if (command === "write") write(parsed)
else if (command === "check") check(parsed)
else if (command === "route") route(parsed)
else fail(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
