#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };
import { assertNativeRuntime, repairNodePtySpawnHelper } from "../src/shared/runtime-guard.js";
import { loadInstances } from "../src/instances/directory.js";
import { resolveInstanceHome } from "../src/instances/create.js";
import { assertContainerPrimaryCommand } from "../src/cli/container-contract.js";
import { retargetInstanceEnv } from "../src/shared/sandbox-env.js";
import { dropInheritedBinding, parsePortOption } from "../src/cli/instance-env.js";
import { PRODUCT_NAME, productBanner } from "../src/shared/brand.js";
import { resolveJinnHome } from "../src/shared/home.js";
import { assertCommandAllowedInHome } from "../src/cli/remote-stage-guard.js";

const program = new Command();
program
  .name("jinn")
  .description(`${PRODUCT_NAME} - lightweight AI gateway daemon (built on Jinn)`)
  .version(productBanner(pkg.version))
  .option("-i, --instance <name>", "Target a specific instance (default: jinn)");

// Pre-parse to set JINN_HOME before any module imports resolve paths
program.hook("preAction", (thisCommand, actionCommand) => {
  const opts = thisCommand.opts();
  const command = actionCommand.name();
  assertContainerPrimaryCommand(command, opts.instance, process.env);
  if (
    process.env.JINN_CONTAINER === "1"
    && process.env._JINN_CONTAINER_SERVICE_START === "1"
    && (command === "setup" || command === "start")
  ) {
    delete process.env._JINN_CONTAINER_SERVICE_START;
  }
  // Verify the native DB addon loads under this Node BEFORE any command pulls in
  // better-sqlite3, so an ABI mismatch prints one clear instruction instead of a
  // cryptic boot crash. Runs for real commands only (not --version/--help).
  assertNativeRuntime();
  // Restore node-pty's spawn-helper exec bit if an --ignore-scripts install
  // (Homebrew's default) left it at 0644. No-op on a healthy install.
  repairNodePtySpawnHelper();
  dropInheritedBinding(process.env);
  if (opts.instance) {
    retargetInstanceEnv({
      home: resolveInstanceHome(opts.instance, loadInstances(), os.homedir()),
      instance: opts.instance,
    });
  }
  // A remote session's staged home leads to the gateway's live data: refuse the
  // commands that would start, stop, migrate or snapshot it from here.
  const commandPath: string[] = [];
  for (let c: Command | null = actionCommand; c && c !== program; c = c.parent) commandPath.unshift(c.name());
  try {
    assertCommandAllowedInHome(commandPath, resolveJinnHome());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
});

program
  .command("setup")
  .description(`Initialize ${PRODUCT_NAME} and install dependencies`)
  .option("--force", "Delete existing home dir and reinitialize from scratch")
  .option("-p, --port <port>", "Gateway port to record in this home's config.yaml", parsePortOption)
  .action(async (opts) => {
    const { runSetup } = await import("../src/cli/setup.js");
    await runSetup(opts);
  });

program
  .command("start")
  .description("Start the gateway daemon")
  .option("--daemon", "Run in background")
  .option("-p, --port <port>", "Override the gateway port from config")
  .option("--take-port", "Take over a port owned by another Marid instance")
  .action(async (opts) => {
    const { runStart } = await import("../src/cli/start.js");
    await runStart({ daemon: opts.daemon, port: opts.port ? parseInt(opts.port, 10) : undefined, takePort: opts.takePort });
  });

program
  .command("stop")
  .description("Stop the gateway daemon")
  .option("-p, --port <port>", "Port to kill the process on (default: from config or 7777)")
  .option("--take-port", "Stop a process on the target port even when it belongs to another Marid instance")
  .action(async (opts: { port?: string; takePort?: boolean }) => {
    const { runStop } = await import("../src/cli/stop.js");
    await runStop(opts.port ? parseInt(opts.port, 10) : undefined, { takePort: opts.takePort });
  });

program
  .command("restart")
  .description("Restart the gateway (detached — safe to run from inside a session)")
  .option("--take-port", "Take over a port owned by another Marid instance")
  .action(async (opts: { takePort?: boolean }) => {
    const { runRestart } = await import("../src/cli/restart.js");
    await runRestart({ takePort: opts.takePort });
  });

program
  .command("status")
  .description("Show gateway status")
  .action(async () => {
    const { runStatus } = await import("../src/cli/status.js");
    await runStatus();
  });

program
  .command("pair")
  .description("Create a one-time code for pairing another browser")
  .option("--json", "Print raw JSON")
  .action(async (opts: { json?: boolean }) => {
    const { runPair } = await import("../src/cli/pair.js");
    await runPair(opts);
  });

program
  .command("unpair [deviceId]")
  .description("List paired browsers or unpair one by id")
  .option("--json", "Print raw JSON")
  .action(async (deviceId: string | undefined, opts: { json?: boolean }) => {
    const { runUnpair } = await import("../src/cli/pair.js");
    await runUnpair(deviceId, opts);
  });

program
  .command("limits")
  .description("Show engine rate limits, quota windows, and model capabilities")
  .option("-e, --engine <name>", "Only show one engine")
  .option("--json", "Print raw JSON")
  .action(async (opts: { engine?: string; json?: boolean }) => {
    const { runLimits } = await import("../src/cli/limits.js");
    await runLimits(opts);
  });

program
  .command("create <name>")
  .description("Create a new Marid instance")
  .option("-p, --port <port>", "Set gateway port (auto-assigned if omitted)")
  .action(async (name: string, opts: { port?: string }) => {
    const { runCreate } = await import("../src/cli/create.js");
    await runCreate(name, opts.port ? parseInt(opts.port, 10) : undefined);
  });

program
  .command("list")
  .description("List all Marid instances")
  .action(async () => {
    const { runList } = await import("../src/cli/list.js");
    await runList();
  });

program
  .command("remove <name>")
  .description("Remove a Marid instance from the registry")
  .option("--force", "Also delete the instance home directory")
  .action(async (name: string, opts: { force?: boolean }) => {
    const { runRemove } = await import("../src/cli/remove.js");
    await runRemove(name, opts);
  });

program
  .command("nuke [name]")
  .description("Permanently delete a Marid instance and all its data")
  .action(async (name?: string) => {
    const { runNuke } = await import("../src/cli/nuke.js");
    await runNuke(name);
  });

program
  .command("migrate")
  .description("Sync the skills Marid ships into this instance and report what changed")
  .action(async () => {
    const { runMigrate } = await import("../src/cli/migrate.js");
    await runMigrate();
  });


// Remote-execution subcommands (jinn remote status|wake).
// An operator affordance only — a turn wakes and verifies its own remote host,
// so nothing here is on the path a session depends on.
{
  const remoteCmd = program
    .command("remote")
    .description("Inspect and wake hosts that run remote employees");

  remoteCmd
    .command("status [employee]")
    .description("Report what a turn would find on each remote host (never wakes one)")
    .action(async (employee?: string) => {
      const { remoteStatus } = await import("../src/cli/remote.js");
      await remoteStatus(employee);
    });

  remoteCmd
    .command("wake [employee]")
    .description("Bring a remote host up and wait for it, without queueing work")
    .action(async (employee?: string) => {
      const { remoteWake } = await import("../src/cli/remote.js");
      await remoteWake(employee);
    });
}

// Skills subcommands (jinn skills find|add|remove|list|update|restore)
{
  const skillsCmd = program
    .command("skills")
    .description("Manage skills from the skills.sh registry");

  skillsCmd
    .command("find [query]")
    .description("Search the skills.sh registry")
    .action(async (query?: string) => {
      const { skillsFind } = await import("../src/cli/skills.js");
      skillsFind(query);
    });

  skillsCmd
    .command("add <package>")
    .description("Install a skill from skills.sh")
    .action(async (pkg: string) => {
      const { skillsAdd } = await import("../src/cli/skills.js");
      skillsAdd(pkg);
    });

  skillsCmd
    .command("remove <name>")
    .description("Remove a skill from this instance")
    .action(async (name: string) => {
      const { skillsRemove } = await import("../src/cli/skills.js");
      skillsRemove(name);
    });

  skillsCmd
    .command("list")
    .description("List installed skills")
    .action(async () => {
      const { skillsList } = await import("../src/cli/skills.js");
      skillsList();
    });

  skillsCmd
    .command("update")
    .description("Re-install all skills to get latest versions")
    .action(async () => {
      const { skillsUpdate } = await import("../src/cli/skills.js");
      skillsUpdate();
    });

  skillsCmd
    .command("restore")
    .description("Install all skills listed in skills.json")
    .action(async () => {
      const { skillsRestore } = await import("../src/cli/skills.js");
      skillsRestore();
    });
}

// Backup subcommands (jinn backup run|list|verify|restore)
const withJson = (command: Command) => command.option("--json", "Print raw JSON");
const backupAction = (name: string) => async (...received: unknown[]) => {
  const command = received.pop() as Command;
  const handlers = await import("../src/cli/backup.js") as unknown as Record<string, (...args: unknown[]) => unknown>;
  await handlers[name]!(...received, command.opts());
};
const backup = program.command("backup").description("Snapshot and restore instance homes");
withJson(backup.command("run").description("Snapshot every registered instance home, then prune")
  .option("--root <dir>", "Where snapshots are written")
  .option("--retention-days <days>", "Days of snapshots to keep")
  .option("--max-total-gb <gb>", "Total size cap across every home")).action(backupAction("runBackup"));
withJson(backup.command("list").description("List the snapshots on disk").option("--root <dir>", "Where snapshots are written"))
  .action(backupAction("runBackupList"));
withJson(backup.command("verify <snapshot>").description("Re-hash a snapshot against its manifest"))
  .action(backupAction("runBackupVerify"));
withJson(backup.command("restore <snapshot>").description("Rebuild a home from a snapshot")
  .requiredOption("--home <dir>", "Directory to rebuild")
  .option("--force", "Restore over a home that is not empty")).action(backupAction("runBackupRestore"));

export function buildProgram(): Command { return program; }
export function isDirectExecution(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) program.parse();
