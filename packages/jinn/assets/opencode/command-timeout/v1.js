/**
 * Marid's command ceiling for opencode 1.x (staged by Marid in every session's
 * config; see docs/engines-opencode.md, "Command timeout").
 *
 * opencode's `bash` tool takes a `timeout` the model chooses, with no upper
 * bound, so a command can run for as long as the model asked: a hung command
 * keeps the turn waiting with it. This caps that timeout at
 * JINN_OPENCODE_COMMAND_TIMEOUT_MS (milliseconds; unset or 0: does nothing).
 * A command asking for more, or for none at all, gets the ceiling; opencode
 * then stops it and tells the model, and the turn carries on.
 *
 * LOADER CONSTRAINT: opencode 1.x calls every export of a plugin module as a
 * plugin, so this file exports exactly one thing.
 */
export const MaridCommandTimeout = async () => {
  const ceiling = Number(process.env.JINN_OPENCODE_COMMAND_TIMEOUT_MS);
  if (!(ceiling > 0)) return {};
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash" || !output.args || typeof output.args !== "object") return;
      const asked = output.args.timeout;
      output.args.timeout = typeof asked === "number" && asked > 0 ? Math.min(asked, ceiling) : ceiling;
    },
  };
};
