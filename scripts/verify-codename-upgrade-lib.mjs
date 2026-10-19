// Helpers for scripts/verify-codename-upgrade.mjs: its arguments and preflight, the scratch host, the
// stand-in `claude`, the gateway calls and the old instance's seeding. Importing it parses the arguments,
// refuses a port a live gateway could own, and makes the scratch host.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => (value.startsWith("--") ? [[value.slice(2), all[index + 1]?.startsWith("--") || all[index + 1] === undefined ? true : all[index + 1]]] : [])));
export const fail = (message, code = 2) => { console.error(`verify-codename-upgrade: ${message}`); process.exit(code); };
export const oldRepo = args.old && path.resolve(String(args.old));
export const newRepo = args.new && path.resolve(String(args.new));
export const codename = String(args.codename ?? "");
export const port = Number(args.port);
if (!oldRepo || !newRepo || !/^[a-z][a-z0-9]*$/.test(codename) || codename === "jinn") fail("usage: --old <repo> --new <repo> --codename <word, not jinn> --port <port>");
if (!Number.isInteger(port) || port < 8060 || port > 65535 || [7777, 7788].includes(port)) fail("--port must be an integer from 8060, never 7777 or 7788"); // footgun: ok the refusal set itself
export const bin = (repo) => path.join(repo, "packages/jinn/dist/bin/jinn.js");
for (const repo of [oldRepo, newRepo]) if (!fs.existsSync(bin(repo))) fail(`not built: ${repo}`);
// A build from before the constant existed is the oldest install there is: it has no file to check.
export const constantFile = (repo) => path.join(repo, "packages/jinn/dist/src/shared/codename-constant.js");
export const constantOf = (repo) => (fs.existsSync(constantFile(repo)) ? /CODENAME = "([a-z0-9]+)"/.exec(fs.readFileSync(constantFile(repo), "utf8"))?.[1] : "jinn");
if (constantOf(oldRepo) !== "jinn") fail(`--old must be built with the legacy codename (it says ${constantOf(oldRepo)})`);
if (constantOf(newRepo) !== codename) fail(`--new must be built with codename "${codename}" (it says ${constantOf(newRepo)})`);

export const NODE = process.execPath;
export const host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codename-upgrade-")));
export const claudeProfile = path.join(host, "claude-profile");
export const standIn = path.join(host, "bin", "claude");
export const instance = "up";
export const oldHome = path.join(host, `.jinn-${instance}`);
export const newHome = path.join(host, `.${codename}-${instance}`);
export const log = path.join(claudeProfile, "stand-in.log");
export const results = [];
export const live = { started: null };
export const baseEnv = () => ({ PATH: `${path.dirname(NODE)}:/usr/bin:/bin`, HOME: host, LANG: "C.UTF-8", CLAUDE_CONFIG_DIR: claudeProfile, JINN_NO_OPEN: "1" });
export const slug = (value) => value.replace(/[^a-zA-Z0-9]/g, "-");

export function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

export function run(file, fileArgs, options = {}) {
  const result = spawnSync(file, fileArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, ...options });
  return { status: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(predicate, what, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try { value = await predicate(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

export function portFree() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function api(method, route, body) {
  const token = JSON.parse(fs.readFileSync(path.join(live.started.home, "gateway.json"), "utf8")).token;
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

export function startGateway(repo, env, home) {
  const result = run(NODE, [bin(repo), "start", "--daemon", "--port", String(port)], { env: { ...baseEnv(), ...env } });
  live.started = { repo, home };
  return result;
}

export async function stopGateway(repo, env) {
  run(NODE, [bin(repo), "stop", "--port", String(port)], { env: { ...baseEnv(), ...env } });
  await until(portFree, `port ${port} to free`, 20_000);
}

export function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

export function seedOld() {
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
  // What an operator wrote that names the built-in server's tools.
  fs.mkdirSync(path.join(oldHome, "skills", "triage"), { recursive: true });
  fs.writeFileSync(path.join(oldHome, "skills", "triage", "SKILL.md"), "---\nname: triage\ndescription: Triage.\n---\nCall mcp__jinn__list_employees first.\n");
  fs.mkdirSync(path.join(oldHome, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(oldHome, ".claude", "settings.json"), '{"permissions":{"allow":["mcp__jinn__*"]}}\n');
  const configFile = path.join(oldHome, "config.yaml");
  fs.writeFileSync(configFile, fs.readFileSync(configFile, "utf8").replace(/^(\s+)bin: claude$/m, `$1bin: ${standIn}`));
}

/** What the old build writes that a move has to carry, written by the old build running turns against the stand-in. */
export async function seedOldState(oldEnv, options = {}) {
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
  if (!options.leaveRunning) await stopGateway(oldRepo, oldEnv);
  return { plain: created.plain, scoped: created.scoped, stageDir, conversations, file };
}

export async function sendAndAwait(sessionId, message, marker) {
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

export const exists = (...segments) => fs.existsSync(path.join(...segments));
export const awaitStatus = (what) => until(async () => (await api("GET", "/api/status")).status === 200, what);
// The service unit's environment still names the old path and the old instance.
export const newEnv = { JINN_HOME: oldHome, JINN_INSTANCE: `jinn-${instance}` };

