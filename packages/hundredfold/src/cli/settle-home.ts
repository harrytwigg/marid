import { NAMES } from "../shared/codename.js";
import { settleInstanceEnv } from "../instances/canonical-env.js";

/**
 * Before a command runs: move a home an older build created to this build's name if it needs it and it
 * is safe (instances/home-rename.ts), and point the environment at whichever home results. `doctor` only
 * reports, so it never moves anything. A conflict stops the command; a home that had to stay is said so
 * and used under its old name.
 */
export async function settleHomeForCommand(command: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (command === "doctor") return;
  const settled = await settleInstanceEnv(env, { log: (message) => console.error(message) });
  if (settled.kind === "conflict") {
    console.error(`Both ${settled.legacyHome} and ${settled.currentHome} exist. Neither was touched; \`${NAMES.codename} doctor\` says what to do.`);
    process.exit(1);
  }
  if (settled.kind === "kept" && settled.blocking) {
    console.error(`${settled.reason}. Nothing was started; run the command again once that has finished.`);
    process.exit(1);
  }
  if (settled.kind === "kept") console.error(`Using ${settled.home} under its old name: ${settled.reason}.`);
}
