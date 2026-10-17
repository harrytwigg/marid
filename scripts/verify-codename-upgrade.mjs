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
//   5. restarts the NEW build again, checks nothing moves twice, and runs `doctor`;
//   6. switches the instance over (`doctor --rename --apply`, gateway stopped): the skill, cron prompt and
//      permission list that say `mcp__jinn__*` are rewritten with their originals kept, the built-in MCP
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
  check,
  claudeProfile,
  codename,
  exists,
  host,
  instance,
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

/** The switch-over command: what it reports, what it rewrites, what it keeps. */
async function applyTheSwitchover(doctor) {
  const report = doctor("--rename");
  check("doctor --rename reports what it would change and changes nothing", report.status === 0 && report.out.includes("would change") && fs.readFileSync(path.join(newHome, "skills/triage/SKILL.md"), "utf8").includes("mcp__jinn__"), report.out.split("\n")[0]);
  const applied = doctor("--rename", "--apply");
  console.log(applied.out.trim());
  check("doctor --rename --apply switches the instance over", applied.status === 0 && applied.out.includes("Switched over"));
  const skill = fs.readFileSync(path.join(newHome, "skills/triage/SKILL.md"), "utf8");
  const settings = readJson(path.join(newHome, ".claude/settings.json"));
  check("the skill and the permission list now name the new tools", skill.includes(`mcp__${codename}__list_employees`) && settings.permissions.allow[0] === `mcp__${codename}__*`);
  const copies = fs.readdirSync(path.join(newHome, ".migration-backups")).filter((name) => name.startsWith("rename-"));
  check("the originals are kept", copies.length === 1 && fs.readFileSync(path.join(newHome, ".migration-backups", copies[0], "skills/triage/SKILL.md"), "utf8").includes("mcp__jinn__list_employees"));
  const block = fs.readFileSync(path.join(newHome, "config.yaml"), "utf8");
  check("config.yaml now keys the instance block by the new name", new RegExp(`^${codename}:`, "m").test(block) && !/^jinn:/m.test(block) && block.includes(`mcpServerName: ${codename}`));
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
  check("the built-in MCP server is registered under the new name, and only that", Boolean(servers[codename]) && !servers.jinn, Object.keys(servers).join(","));
  const after = doctor();
  check("doctor reports the instance switched over, with nothing left to do", !after.out.includes("ACTION") && after.out.includes("switched over"), after.out.split("\n").filter((line) => line.includes("MCP")).join(" | "));
  await stopGateway(newRepo, newEnv);
}

async function checkTheSwitchover(state) {
  const doctor = (...flags) => run(NODE, [bin(newRepo), "doctor", ...flags], { env: { ...baseEnv(), ...newEnv } });
  await applyTheSwitchover(doctor);
  await useTheSwitchedOverInstance(state, doctor);
}

async function main() {
  console.log(`host ${host}`);
  seedOld();
  const state = await seedOldState({ JINN_HOME: oldHome, JINN_INSTANCE: `jinn-${instance}` });
  console.log(`old home ${oldHome}\nscoped department stage ${state.stageDir}`);
  const upgraded = startGateway(newRepo, newEnv, newHome);
  console.log(upgraded.out.trim());
  check("the new build starts", upgraded.status === 0);
  live.started.home = newHome;
  await awaitStatus("the new gateway");
  const newStage = path.join(host, `.${codename}-departments`, ".instances", `.${codename}-${instance}`, "side-project");
  await checkTheMove(state, newStage);
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
  if (live.started && !(await portFree())) { try { await stopGateway(live.started.repo, live.started.repo === newRepo ? { JINN_HOME: newHome } : { JINN_HOME: oldHome }); } catch { /* reported below */ } }
  const leaked = !(await portFree());
  if (leaked) console.error(`FAIL  port ${port} is still listening`);
  if (args.keep) console.log(`kept ${host}`);
  else if (!leaked) fs.rmSync(host, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed || leaked ? 1 : 0);
}

