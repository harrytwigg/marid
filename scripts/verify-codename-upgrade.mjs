#!/usr/bin/env node
// Upgrade rehearsal for a change of codename, on a throwaway host.
//
//   node scripts/verify-codename-upgrade.mjs --old <repo> --new <repo> --codename <word> --port <port> [--keep]
//
// `--old` is a built checkout of a release from before the rename, which every existing install was made with.
// `--new` is a built checkout of this tree. `--codename` is the name the new build carries (it must differ from
// the old one). The script:
//
//   1. makes a real-shaped instance with the OLD build, in a scratch host home: a sessions database with a
//      conversation-bearing session and one bound to a scoped department, an attachment, a department stage
//      directory, a host registry entry, and Claude conversations filed under both working directories;
//   2. starts and stops it with the OLD build, as the operator's service would have;
//   3. starts the NEW build against the OLD home path and instance name, exactly as that service's unit
//      would (the old home variable set to the old path), so the home has to move on its own. With `--restart` the old gateway is
//      left running instead and the NEW build's restart helper is run over it, as `restart` after an upgrade
//      would: the home has to move between the old gateway stopping and the new one starting;
//   4. checks one identity (home, stage root, registry entry), that the conversations followed, and that
//      sessions resume, fork and auto-compact through the real gateway against a stand-in `claude` that
//      refuses a conversation not filed under the physical directory it runs in;
//   5. restarts the NEW build again, checks nothing moves twice, and runs `doctor`;
//   6. switches the instance over (`doctor --rename --apply`, gateway stopped): the skill, cron prompt and
//      permission list that name the old built-in tools are rewritten with their originals kept, the built-in MCP
//      server is registered under the new name from the next start, and a session still resumes.
//
// Nothing outside the scratch host is read or written, and the port must be one a live gateway cannot own.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  NODE,
  api,
  args,
  awaitStatus,
  baseEnv,
  bin,
  pkgDir,
  check,
  claudeProfile,
  codename,
  OLD,
  OLDUP,
  exists,
  fail,
  host,
  instance,
  until,
  live,
  log,
  newEnv,
  newHome,
  newRepo,
  oldHome,
  oldRepo,
  port,
  portFree,
  readJson,
  results,
  run,
  seedOld,
  seedOldState,
  sendAndAwait,
  slug,
  startGateway,
  stopGateway,
} from "./verify-codename-upgrade-lib.mjs";

/** What the move did to the disk and the registry. */
async function checkTheMove(state, newStage) {
  check("the home moved, and a link stays at the old path", exists(newHome, "sessions", "registry.db") && fs.lstatSync(oldHome).isSymbolicLink() && fs.realpathSync(oldHome) === newHome);
  check("one stage root, under the new container, and none under the old", exists(newStage, "CLAUDE.md") && !exists(host, `.${OLD}-departments`));
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
  // The old build's asset, rendered the way its gateway renders it when it stages one.
  const relay = path.join(host, "old-hook-relay.mjs");
  fs.writeFileSync(relay, fs.readFileSync(path.join(oldRepo, pkgDir(oldRepo), "assets/hook-relay.mjs"), "utf8").replaceAll("__CODENAME__", OLD));
  const payload = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf ~" } };
  const blocked = spawnSync(NODE, [relay, state.plain], { input: JSON.stringify(payload), encoding: "utf8", env: { PATH: baseEnv().PATH, HOME: host, [`${OLDUP}_HOME`]: oldHome } });
  check("a hook relay staged by the old build is still obeyed by the new gateway", blocked.status === 2 && /destructive/i.test(blocked.stderr), `exit ${blocked.status}: ${blocked.stderr.trim().slice(0, 80)}`);
  const mcpDir = path.join(newHome, "tmp", "mcp");
  const staged = fs.existsSync(mcpDir) ? fs.readdirSync(mcpDir).flatMap((dir) => { try { return [readJson(path.join(mcpDir, dir, "config.json"))]; } catch { return []; } }) : [];
  check("the built-in MCP server keeps its old name on an upgraded instance, once", staged.length > 0 && staged.every((config) => config.mcpServers?.[OLD] && !config.mcpServers?.[codename]), `${staged.length} staged config(s)`);
  const doctor = run(NODE, [bin(newRepo), "doctor"], { env: { ...baseEnv(), ...newEnv } });
  check("doctor reports nothing left to do", !doctor.out.includes("ACTION"), doctor.out.split("\n").filter((line) => line.startsWith("ACTION")).join(" | "));
  console.log(doctor.out.trim());
}

async function checkARestart(state) {
  await stopGateway(newRepo, newEnv);
  const before = fs.readdirSync(host).sort().join(",");
  const again = startGateway(newRepo, newEnv, newHome);
  await awaitStatus("the restarted gateway");
  check("a restart with the old path and name moves nothing again", again.status === 0 && fs.readdirSync(host).sort().join(",") === before && !exists(host, `.${OLD}-departments`));
  const resumedAgain = await sendAndAwait(state.plain, "and once more", "and once more");
  check("and the session still resumes", resumedAgain.ok && !resumedAgain.log.includes("refused"), resumedAgain.detail ?? "");
  await stopGateway(newRepo, newEnv);
}

/** The switch-over command: what it reports, what it rewrites, what it keeps. */
async function applyTheSwitchover(doctor) {
  const report = doctor("--rename");
  check("doctor --rename reports what it would change and changes nothing", report.status === 0 && report.out.includes("would change") && fs.readFileSync(path.join(newHome, "skills/triage/SKILL.md"), "utf8").includes(`mcp__${OLD}__`), report.out.split("\n")[0]);
  const applied = doctor("--rename", "--apply");
  console.log(applied.out.trim());
  check("doctor --rename --apply switches the instance over", applied.status === 0 && applied.out.includes("Switched over"));
  const skill = fs.readFileSync(path.join(newHome, "skills/triage/SKILL.md"), "utf8");
  const settings = readJson(path.join(newHome, ".claude/settings.json"));
  check("the skill and the permission list now name the new tools", skill.includes(`mcp__${codename}__list_employees`) && settings.permissions.allow[0] === `mcp__${codename}__*`);
  const copies = fs.readdirSync(path.join(newHome, ".migration-backups")).filter((name) => name.startsWith("rename-"));
  check("the originals are kept", copies.length === 1 && fs.readFileSync(path.join(newHome, ".migration-backups", copies[0], "skills/triage/SKILL.md"), "utf8").includes(`mcp__${OLD}__list_employees`));
  const block = fs.readFileSync(path.join(newHome, "config.yaml"), "utf8");
  check("config.yaml now keys the instance block by the new name", new RegExp(`^${codename}:`, "m").test(block) && !new RegExp(`^${OLD}:`, "m").test(block) && block.includes(`mcpServerName: ${codename}`));
}

/** Start the switched-over gateway and use it: sessions resume, and the server has the new name. */
async function useTheSwitchedOverInstance(state, doctor) {
  startGateway(newRepo, newEnv, newHome);
  await awaitStatus("the switched-over gateway");
  const stage = path.join(host, `.${codename}-departments`, ".instances", `.${codename}-${instance}`, "side-project");
  const turn = await sendAndAwait(state.plain, "after the switch-over", "after the switch-over");
  check("a session still resumes after the switch-over", turn.ok && !turn.log.includes("refused"), turn.detail ?? "");
  const scoped = await sendAndAwait(state.scoped, "scoped after the switch-over", "scoped after the switch-over");
  check("and so does a department-scoped one", scoped.ok && scoped.log.includes(`cwd=${stage}`) && !scoped.log.includes("refused"), scoped.detail ?? "");
  const mcpDir = path.join(newHome, "tmp", "mcp");
  const newest = fs.readdirSync(mcpDir).map((dir) => path.join(mcpDir, dir, "config.json")).filter((file) => fs.existsSync(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const servers = readJson(newest).mcpServers ?? {};
  check("the built-in MCP server is registered under the new name, and only that", Boolean(servers[codename]) && !servers[OLD], Object.keys(servers).join(","));
  const after = doctor();
  check("doctor reports the instance switched over, with nothing left to do", !after.out.includes("ACTION") && after.out.includes("switched over"), after.out.split("\n").filter((line) => line.includes("MCP")).join(" | "));
  await stopGateway(newRepo, newEnv);
}

async function checkTheSwitchover(state) {
  const doctor = (...flags) => run(NODE, [bin(newRepo), "doctor", ...flags], { env: { ...baseEnv(), ...newEnv } });
  await applyTheSwitchover(doctor);
  await useTheSwitchedOverInstance(state, doctor);
}

/** The new build's restart helper, run over the old build's live gateway: it stops it, settles the home, and starts the new one. */
async function restartOverTheRunningGateway() {
  const helper = path.join(newRepo, pkgDir(newRepo), "dist/src/gateway/restart-entry.js");
  const started = run(NODE, [helper, "--port", String(port)], { env: { ...baseEnv(), ...newEnv } });
  console.log(started.out.trim());
  check("the restart helper ran", started.status === 0, started.out.trim().split("\n").pop());
  live.started = { repo: newRepo, home: newHome };
  await until(async () => exists(newHome, "sessions", "registry.db") && (await api("GET", "/api/status")).status === 200, "the gateway to come back from the moved home");
}

/**
 * What an old install stored or handed out that a later build must still accept: a paired device, a member token
 * and an MCP session capability, minted by the OLD build's own code and checked by the NEW build's.
 */
function mintOldCredentials() {
  const script = `
    const dist = (file) => import(process.argv[1] + "/dist/src/" + file);
    const [{ createAuthSession }, { hashToken }, { ensureSessionCapability }] = await Promise.all([dist("gateway/auth.js"), dist("accounts/ids.js"), dist("mcp/identity.js")]);
    const { secret, device } = createAuthSession(process.argv[2], { headers: {}, socket: { remoteAddress: "10.0.0.9" } }, { name: "rehearsal device", kind: "remote" });
    console.log(JSON.stringify({ secret, deviceId: device.id, token: hashToken("member-token", "token"), capability: ensureSessionCapability("rehearsal-session", process.argv[3]) }));`;
  const keyFile = path.join(host, "capability.key");
  const minted = run(NODE, ["--input-type=module", "-e", script, path.join(oldRepo, pkgDir(oldRepo)), oldHome, keyFile], { env: { ...baseEnv(), [`${OLDUP}_HOME`]: oldHome } });
  if (minted.status !== 0) fail(`could not mint credentials with the old build:\n${minted.out}`, 1);
  return { ...JSON.parse(minted.out.trim().split("\n").pop()), keyFile };
}

function checkOldCredentials(minted) {
  const script = `
    const dist = (file) => import(process.argv[1] + "/dist/src/" + file);
    const [{ verifyAuthSession }, { hashToken }, { verifySessionCapability }] = await Promise.all([dist("gateway/auth.js"), dist("accounts/ids.js"), dist("mcp/identity.js")]);
    const [home, deviceId, secret, capability, keyFile] = process.argv.slice(2);
    console.log(JSON.stringify({ device: verifyAuthSession(home, deviceId, secret), wrong: verifyAuthSession(home, deviceId, "not-the-secret"), token: hashToken("member-token", "token"), capability: verifySessionCapability("rehearsal-session", capability, keyFile) }));`;
  const checked = run(NODE, ["--input-type=module", "-e", script, path.join(newRepo, pkgDir(newRepo)), newHome, minted.deviceId, minted.secret, minted.capability, minted.keyFile], { env: { ...baseEnv(), ...newEnv } });
  const result = checked.status === 0 ? JSON.parse(checked.out.trim().split("\n").pop()) : {};
  check("a device the old build paired is still recognised", result.device === true && result.wrong === false, checked.out.trim().split("\n").pop());
  check("a member token the old build hashed still matches", result.token === minted.token);
  check("an MCP capability the old build handed out still verifies", result.capability === true);
}

async function main() {
  console.log(`host ${host}`);
  seedOld();
  const state = await seedOldState({ [`${OLDUP}_HOME`]: oldHome, [`${OLDUP}_INSTANCE`]: `${OLD}-${instance}` }, { leaveRunning: Boolean(args.restart) });
  const credentials = mintOldCredentials();
  console.log(`old home ${oldHome}\nscoped department stage ${state.stageDir}`);
  if (args.restart) {
    await restartOverTheRunningGateway();
  } else {
    const upgraded = startGateway(newRepo, newEnv, newHome);
    console.log(upgraded.out.trim());
    check("the new build starts", upgraded.status === 0);
    live.started.home = newHome;
  }
  await awaitStatus("the new gateway");
  const newStage = path.join(host, `.${codename}-departments`, ".instances", `.${codename}-${instance}`, "side-project");
  await checkTheMove(state, newStage);
  checkOldCredentials(credentials);
  await checkSessions(state, newStage);
  checkTheRest(state);
  await checkARestart(state);
  await checkTheSwitchover(state);
}

try {
  await main();
} catch (error) {
  check("the rehearsal ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
  if (live.started && !(await portFree())) { try { await stopGateway(live.started.repo, live.started.repo === newRepo ? { [`${OLDUP}_HOME`]: newHome } : { [`${OLDUP}_HOME`]: oldHome }); } catch { /* reported below */ } }
  const leaked = !(await portFree());
  if (leaked) console.error(`FAIL  port ${port} is still listening`);
  if (args.keep) console.log(`kept ${host}`);
  else if (!leaked) fs.rmSync(host, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed || leaked ? 1 : 0);
}

