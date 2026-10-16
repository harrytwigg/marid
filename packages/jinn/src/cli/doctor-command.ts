import type { Command } from "commander";

/** `doctor`: what an install carries from before the codename changed, and what was done about it. */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Report what this install carries from before the codename changed, and what was done about it")
    .option("--json", "Print the findings as JSON")
    .action(async (opts) => {
      const { runDoctor } = await import("./doctor.js");
      runDoctor({ json: opts.json });
    });
}
