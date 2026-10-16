#!/usr/bin/env node
// Upgrade rehearsal for a change of codename, on a throwaway host.
//
//   node scripts/verify-codename-upgrade.mjs --old <repo> --new <repo> --codename <word> --port <port> [--keep]
//
// `--old` is a checkout built with the codename every existing install carries. `--new` is a checkout built
// with `--codename` in `packages/jinn/src/shared/codename-constant.ts` (and in nothing else): the same source,
// one literal changed, built. The script:
//
//   1. makes a real-shaped instance with the OLD build, in a scratch host home: a sessions database with a
//      conversation-bearing session and one bound to a scoped department, an attachment, a department stage
//      directory, a host registry entry, and Claude conversations filed under both working directories;
//   2. starts and stops it with the OLD build, as the operator's service would have;
//   3. starts the NEW build against the OLD home path and instance name, exactly as that service's unit
//      would (`JINN_HOME=<old path>`), so the home has to move on its own;
//   4. checks one identity (home, stage root, registry entry), that the conversations followed, and that
//      sessions resume, fork and auto-compact through the real gateway against a stand-in `claude` that
//      refuses a conversation not filed under the physical directory it runs in;
//   5. restarts the NEW build again, checks nothing moves twice, and runs `doctor`.
//
// Nothing outside the scratch host is read or written, and the port must be one a live gateway cannot own.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => (value.startsWith("--") ? [[value.slice(2), all[index + 1]?.startsWith("--") || all[index + 1] === undefined ? true : all[index + 1]]] : [])));
const fail = (message, code = 2) => { console.error(`verify-codename-upgrade: ${message}`); process.exit(code); };
const oldRepo = args.old && path.resolve(String(args.old));
const newRepo = args.new && path.resolve(String(args.new));
const codename = String(args.codename ?? "");
const port = Number(args.port);
if (!oldRepo || !newRepo || !/^[a-z][a-z0-9]*$/.test(codename) || codename === "jinn") fail("usage: --old <repo> --new <repo> --codename <word, not jinn> --port <port>");
if (!Number.isInteger(port) || port < 8060 || port > 65535 || [7777, 7788].includes(port)) fail("--port must be an integer from 8060, never 7777 or 7788"); // footgun: ok the refusal set itself
const bin = (repo) => path.join(repo, "packages/jinn/dist/bin/jinn.js");
for (const repo of [oldRepo, newRepo]) if (!fs.existsSync(bin(repo))) fail(`not built: ${repo}`);
// A build from before the constant existed is the oldest install there is: it has no file to check.
const constantFile = (repo) => path.join(repo, "packages/jinn/dist/src/shared/codename-constant.js");
const constantOf = (repo) => (fs.existsSync(constantFile(repo)) ? /CODENAME = "([a-z0-9]+)"/.exec(fs.readFileSync(constantFile(repo), "utf8"))?.[1] : "jinn");
if (constantOf(oldRepo) !== "jinn") fail(`--old must be built with the legacy codename (it says ${constantOf(oldRepo)})`);
if (constantOf(newRepo) !== codename) fail(`--new must be built with codename "${codename}" (it says ${constantOf(newRepo)})`);

const NODE = process.execPath;
const host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codename-upgrade-")));
const claudeProfile = path.join(host, "claude-profile");
const standIn = path.join(host, "bin", "claude");
const instance = "up";
const oldHome = path.join(host, `.jinn-${instance}`);
const newHome = path.join(host, `.${codename}-${instance}`);
const log = path.join(claudeProfile, "stand-in.log");
const results = [];
let started = null;
const baseEnv = () => ({ PATH: `${path.dirname(NODE)}:/usr/bin:/bin`, HOME: host, LANG: "C.UTF-8", CLAUDE_CONFIG_DIR: claudeProfile, JINN_NO_OPEN: "1" });
const slug = (value) => value.replace(/[^a-zA-Z0-9]/g, "-");

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function run(file, fileArgs, options = {}) {
  const result = spawnSync(file, fileArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, ...options });
  return { status: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, what, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try { value = await predicate(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

function portFree() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function api(method, route, body) {
  const token = JSON.parse(fs.readFileSync(path.join(started.home, "gateway.json"), "utf8")).token;
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json, text };
}

function startGateway(repo, env, home) {
  const result = run(NODE, [bin(repo), "start", "--daemon", "--port", String(port)], { env: { ...baseEnv(), ...env } });
  started = { repo, home };
  return result;
}

async function stopGateway(repo, env) {
  run(NODE, [bin(repo), "stop", "--port", String(port)], { env: { ...baseEnv(), ...env } });
  await until(portFree, `port ${port} to free`, 20_000);
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function seedOld() {
  const helper = path.join(oldRepo, "scripts/jinn-sandbox.sh");
  const created = run("bash", [helper, "create", instance, "--port", String(port), "--seed"], { env: { PATH: baseEnv().PATH, HOME: host, JINN_REPO: oldRepo } });
  if (created.status !== 0) fail(`could not create the old instance:\n${created.out}`, 1);
  const seeded = run(NODE, [path.join(oldRepo, "scripts/seed-departments.mjs"), oldHome], { env: baseEnv() });
  if (seeded.status !== 0) fail(`could not seed departments:\n${seeded.out}`, 1);
  fs.mkdirSync(path.dirname(standIn), { recursive: true });
  fs.copyFileSync(path.join(here, "verify-codename-upgrade-claude.cjs"), standIn);
  fs.chmodSync(standIn, 0o755);
  fs.mkdirSync(path.join(oldHome, "attachments", "2026-10"), { recursive: true });
  fs.writeFileSync(path.join(oldHome, "attachments", "2026-10", "note.txt"), "an attachment from before the move");
  const configFile = path.join(oldHome, "config.yaml");
  fs.writeFileSync(configFile, fs.readFileSync(configFile, "utf8").replace(/^(\s+)bin: claude$/m, `$1bin: ${standIn}`));
}

/** What the old build writes that a move has to carry, written by the old build running turns against the stand-in. */
async function seedOldState(oldEnv) {
  const record = run(NODE, ["--input-type=module", "-e", `
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const directory = await import(pathToFileURL(path.join(${JSON.stringify(oldRepo)}, "packages/jinn/dist/src/instances/directory.js")).href);
    directory.saveInstances([{ name: "jinn-${instance}", home: process.env.JINN_HOME, port: ${port}, createdAt: new Date().toISOString(), kind: "workspace", pinned: true }]);
  `], { env: { ...baseEnv(), ...oldEnv } });
  if (record.status !== 0) fail(`could not register the old instance:\n${record.out}`, 1);

  const oldRun = startGateway(oldRepo, oldEnv, oldHome);
  check("the old build starts on the old home", oldRun.status === 0, oldRun.out.trim().split("\n").pop());
  await until(async () => (await api("GET", "/api/status")).status === 200, "the old gateway");
  const created = {};
  for (const [key, body] of [["plain", { prompt: "an earlier turn", engine: "claude" }], ["scoped", { prompt: "an earlier department turn", engine: "claude", employee: "side-dev" }]]) {
    const response = await api("POST", "/api/sessions", body);
    if (response.status >= 300) fail(`the old gateway refused a ${key} session: ${response.status} ${response.text.slice(0, 160)}`, 1);
    created[key] = response.json.id;
  }
  const conversations = {};
  for (const key of ["plain", "scoped"]) {
    const session = await until(async () => {
      const found = (await api("GET", `/api/sessions/${created[key]}`)).json;
      return found?.engineSessionId && found.status === "idle" ? found : undefined;
    }, `the old ${key} session to settle with a conversation`, 90_000);
    conversations[key] = session.engineSessionId;
  }
  const scopedSession = (await api("GET", `/api/sessions/${created.scoped}`)).json;
  check("the old build bound the second session to its department", scopedSession.scopeDepartment === "side-project", String(scopedSession.scopeDepartment));
  const stageDir = fs.realpathSync(path.join(host, ".jinn-departments", ".instances", `.jinn-${instance}`, "side-project"));
  const file = (cwd, id) => path.join(claudeProfile, "projects", slug(fs.realpathSync(cwd)), `${id}.jsonl`);
  check("the old build filed both conversations under their physical directories", fs.existsSync(file(oldHome, conversations.plain)) && fs.existsSync(file(stageDir, conversations.scoped)));
  await stopGateway(oldRepo, oldEnv);
  return { plain: created.plain, scoped: created.scoped, stageDir, conversations, file };
}

async function sendAndAwait(sessionId, message, marker) {
  const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8").length : 0;
  const sent = await api("POST", `/api/sessions/${sessionId}/message`, { message });
  if (![200, 201, 202].includes(sent.status)) return { ok: false, detail: `POST message answered ${sent.status}: ${sent.text.slice(0, 120)}` };
  try {
    await until(() => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(before).includes(marker) : false), `the stand-in to see ${marker}`, 45_000);
  } catch (error) {
    return { ok: false, detail: error.message };
  }
  await until(async () => ["idle", "error"].includes((await api("GET", `/api/sessions/${sessionId}`)).json?.status), "the turn to settle", 45_000).catch(() => undefined);
  const session = (await api("GET", `/api/sessions/${sessionId}`)).json;
  return { ok: true, session, log: fs.readFileSync(log, "utf8").slice(before) };
}

const exists = (...segments) => fs.existsSync(path.join(...segments));
const awaitStatus = (what) => until(async () => (await api("GET", "/api/status")).status === 200, what);
// The service unit's environment still names the old path and the old instance.
const newEnv = { JINN_HOME: oldHome, JINN_INSTANCE: `jinn-${instance}` };

/** What the move did to the disk and the registry. */
async function checkTheMove(state, newStage) {
  check("the home moved, and a link stays at the old path", exists(newHome, "sessions", "registry.db") && fs.lstatSync(oldHome).isSymbolicLink() && fs.realpathSync(oldHome) === newHome);
  check("one stage root, under the new container, and none under the old", exists(newStage, "CLAUDE.md") && !exists(host, ".jinn-departments"));
  await checkTheRecords(state, newStage);
}

/** The registry, the conversations' keys and the database, after the move. */
async function checkTheRecords(state, newStage) {
  const registryFile = path.join(host, ".config", codename, "instances.json");
  const registry = fs.existsSync(registryFile) ? readJson(registryFile).instances : [];
  check("the registry was rewritten: one entry, new name, new home", registry.length === 1 && registry[0].name === `${codename}-${instance}` && registry[0].home === newHome, JSON.stringify(registry.map((r) => [r.name, r.home])));
  check("the conversations moved with the working directories", fs.existsSync(state.file(newHome, state.conversations.plain)) && fs.existsSync(state.file(newStage, state.conversations.scoped)));
  check("none is left under the old keys", !exists(claudeProfile, "projects", slug(oldHome)) && !exists(claudeProfile, "projects", slug(state.stageDir)));
  const listed = (await api("GET", "/api/sessions")).json;
  const sessions = listed?.sessions ?? listed ?? [];
  check("the sessions database came across", [state.plain, state.scoped].every((id) => sessions.some((s) => s.id === id)));
  check("the attachment is where it was, through either path", fs.readFileSync(path.join(newHome, "attachments/2026-10/note.txt"), "utf8").startsWith("an attachment") && exists(oldHome, "attachments/2026-10/note.txt"));
}

/** Resume, fork and compact, through the real gateway, against a stand-in that refuses a conversation filed under the wrong directory. */
async function checkSessions(state, newStage) {
  const clean = (turn, id) => turn.ok && turn.log.includes(`resume=${id}`) && !turn.log.includes("refused");
  const resumed = await sendAndAwait(state.plain, "hello after the move", "hello after the move");
  check("a session resumes its conversation after the move", clean(resumed, state.conversations.plain) && resumed.log.includes(`cwd=${newHome}`), resumed.detail ?? "");
  const scoped = await sendAndAwait(state.scoped, "hello from the department", "hello from the department");
  check("a department-scoped session resumes in the moved stage directory", clean(scoped, state.conversations.scoped) && scoped.log.includes(`cwd=${newStage}`), scoped.detail ?? "");
  const duplicate = await api("POST", `/api/sessions/${state.plain}/duplicate`);
  check("a session forks after the move", duplicate.status < 300 && fs.readFileSync(log, "utf8").includes(`forked ${state.conversations.plain} ->`), `${duplicate.status} ${duplicate.text.slice(0, 100)}`);
  const compacted = await sendAndAwait(state.plain, "/compact", "/compact");
  check("a session compacts after the move", clean(compacted, state.conversations.plain), compacted.detail ?? "");
}

/** What an older install's other pieces make of the new gateway: its relay, its staged MCP config, `doctor`. */
function checkTheRest(state) {
  // A relay an older gateway staged names its home, its header and its field the old way; a blocked command
  // (exit 2, the policy's own answer) proves the new gateway read all three.
  const relay = path.join(oldRepo, "packages/jinn/assets/hook-relay.mjs");
  const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf ~" } };
  const blocked = spawnSync(NODE, [relay, state.plain], { input: JSON.stringify(payload), encoding: "utf8", env: { PATH: baseEnv().PATH, HOME: host, JINN_HOME: oldHome } });
  check("a hook relay staged by the old build is still obeyed by the new gateway", blocked.status === 2 && /destructive/i.test(blocked.stderr), `exit ${blocked.status}: ${blocked.stderr.trim().slice(0, 80)}`);
  const mcpDir = path.join(newHome, "tmp", "mcp");
  const staged = fs.existsSync(mcpDir) ? fs.readdirSync(mcpDir).flatMap((dir) => { try { return [readJson(path.join(mcpDir, dir, "config.json"))]; } catch { return []; } }) : [];
  check("the built-in MCP server keeps its old name on an upgraded instance, once", staged.length > 0 && staged.every((config) => config.mcpServers?.jinn && !config.mcpServers?.[codename]), `${staged.length} staged config(s)`);
  const doctor = run(NODE, [bin(newRepo), "doctor"], { env: { ...baseEnv(), ...newEnv } });
  check("doctor reports nothing left to do", !doctor.out.includes("ACTION"), doctor.out.split("\n").filter((line) => line.startsWith("ACTION")).join(" | "));
  console.log(doctor.out.trim());
}

async function checkARestart(state) {
  await stopGateway(newRepo, newEnv);
  const before = fs.readdirSync(host).sort().join(",");
  const again = startGateway(newRepo, newEnv, newHome);
  await awaitStatus("the restarted gateway");
  check("a restart with the old path and name moves nothing again", again.status === 0 && fs.readdirSync(host).sort().join(",") === before && !exists(host, ".jinn-departments"));
  const resumedAgain = await sendAndAwait(state.plain, "and once more", "and once more");
  check("and the session still resumes", resumedAgain.ok && !resumedAgain.log.includes("refused"), resumedAgain.detail ?? "");
  await stopGateway(newRepo, newEnv);
}

async function main() {
  console.log(`host ${host}`);
  seedOld();
  const state = await seedOldState({ JINN_HOME: oldHome, JINN_INSTANCE: `jinn-${instance}` });
  console.log(`old home ${oldHome}\nscoped department stage ${state.stageDir}`);
  const upgraded = startGateway(newRepo, newEnv, newHome);
  console.log(upgraded.out.trim());
  check("the new build starts", upgraded.status === 0);
  started.home = newHome;
  await awaitStatus("the new gateway");
  const newStage = path.join(host, `.${codename}-departments`, ".instances", `.${codename}-${instance}`, "side-project");
  await checkTheMove(state, newStage);
  await checkSessions(state, newStage);
  checkTheRest(state);
  await checkARestart(state);
}

try {
  await main();
} catch (error) {
  check("the rehearsal ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
  if (started && !(await portFree())) { try { await stopGateway(started.repo, started.repo === newRepo ? { JINN_HOME: newHome } : { JINN_HOME: oldHome }); } catch { /* reported below */ } }
  const leaked = !(await portFree());
  if (leaked) console.error(`FAIL  port ${port} is still listening`);
  if (args.keep) console.log(`kept ${host}`);
  else if (!leaked) fs.rmSync(host, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed || leaked ? 1 : 0);
}
