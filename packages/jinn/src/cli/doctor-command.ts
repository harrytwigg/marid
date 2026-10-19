import type { Command } from "commander";

/** `doctor` and `doctor --rename`: what an install carries from before the codename changed, and the switch-over. */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Report what this install carries from before the codename changed, and what was done about it")
    .option("--json", "Print the findings as JSON")
    .option("--rename", "Report what switching this instance over to the current codename would change")
    .option("--apply", "With --rename: make the change, after a snapshot, with the originals kept")
    .action(async (opts) => {
      const { runDoctor } = await import("./doctor.js");
      await runDoctor({ json: opts.json, rename: opts.rename, apply: opts.apply });
    });
}
