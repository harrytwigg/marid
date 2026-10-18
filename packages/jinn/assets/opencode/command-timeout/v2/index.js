/**
 * Marid's command ceiling for OpenCode 2 (staged by Marid in every session's
 * config; see docs/engines-opencode.md, "Command timeout").
 *
 * OpenCode 2's `shell` tool takes a `timeout` the model chooses: 120 s by
 * default in the foreground, with no upper bound, and `0` turns it off. So a
 * command can run for as long as the model asked, and a hung one keeps the turn
 * waiting with it. This caps the timeout of every foreground command at
 * JINN_OPENCODE_COMMAND_TIMEOUT_MS (milliseconds; unset or 0: does nothing).
 * A command asking for more, for 0, or for no timeout gets the ceiling;
 * opencode then stops it and tells the model, and the turn carries on.
 * Background commands (`background: true`) are left alone: they do not hold
 * the turn, and a dev server is meant to keep running.
 */
export default {
  id: "marid-command-timeout",
  setup: async (ctx) => {
    const ceiling = Number(process.env.JINN_OPENCODE_COMMAND_TIMEOUT_MS);
    if (!(ceiling > 0)) return;
    await ctx.tool.hook("execute.before", async (event) => {
      const input = event.input;
      if (event.tool !== "shell" || !input || typeof input !== "object" || input.background === true) return;
      const asked = input.timeout;
      input.timeout = typeof asked === "number" && asked > 0 ? Math.min(asked, ceiling) : ceiling;
    });
  },
};
