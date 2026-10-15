import { describe, expect, it } from "vitest";
import type { ResolvedMcpConfig } from "../../shared/types.js";
import { buildMuseViewArgs, buildMuseViewMcp } from "../musecode-view-args.js";

const ID = "01a13fb8-5801-7983-8ae6-77432f86606b";
const RULES_OFF = ["-c", "context.foreign_personal_rules=false", "-c", "context.foreign_personal_skills=false"];

describe("buildMuseViewArgs", () => {
  it("resumes the session's conversation", () => {
    expect(buildMuseViewArgs({ engineSessionId: ID }).args).toEqual(["resume", ID, "--disable-sandbox", ...RULES_OFF]);
  });

  it("opens a fresh TUI when there is no conversation yet", () => {
    expect(buildMuseViewArgs({}).args).toEqual(["--disable-sandbox", ...RULES_OFF]);
  });

  it("puts the model before, and the employee's own flags after, everything the gateway adds", () => {
    const { args } = buildMuseViewArgs({ engineSessionId: ID, model: "muse-spark-1.2", cliFlags: ["--provider", "echo"] });
    expect(args).toEqual(["resume", ID, "--disable-sandbox", ...RULES_OFF, "--model", "muse-spark-1.2", "--provider", "echo"]);
  });
});

describe("buildMuseViewMcp", () => {
  const resolved = {
    mcpServers: {
      jinn: { command: "/usr/bin/node", args: ["/opt/jinn/server-entry.js"], env: { JINN_HOME: "/home/x/.jinn", JINN_SESSION_ID: "s-1", EMPTY: "" } },
      remote: { url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer sekrit-token" } },
      "bad.name": { command: "/bin/true" },
    },
  } as unknown as ResolvedMcpConfig;

  it("names each server in its own -c, jinn optional, with every env and header value a reference", () => {
    const { flags, env, skipped } = buildMuseViewMcp(resolved);
    expect(flags.filter((f) => f === "-c")).toHaveLength(2);
    const jinn = JSON.parse(flags[1].replace("mcpServers.jinn=", ""));
    expect(flags[1]).toMatch(/^mcpServers\.jinn=/);
    expect(jinn).toEqual({
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["/opt/jinn/server-entry.js"],
      env: { JINN_HOME: "${MARID_MCP_1}", JINN_SESSION_ID: "${MARID_MCP_2}" },
      mode: "optional",
    });
    expect(JSON.parse(flags[3].replace("mcpServers.remote=", ""))).toEqual({
      transport: "streamableHttp",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "${MARID_MCP_3}" },
    });
    expect(env).toEqual({ MARID_MCP_1: "/home/x/.jinn", MARID_MCP_2: "s-1", MARID_MCP_3: "Bearer sekrit-token" });
    expect(skipped).toEqual(["bad.name"]);
  });

  it("never puts a value on the command line", () => {
    const { args, env } = buildMuseViewArgs({ engineSessionId: ID, resolvedMcp: resolved });
    const joined = args.join(" ");
    for (const value of Object.values(env)) expect(joined).not.toContain(value);
    expect(joined).not.toContain("sekrit-token");
  });

  it("adds nothing for a session with no servers", () => {
    expect(buildMuseViewMcp(undefined)).toEqual({ flags: [], env: {}, skipped: [] });
    expect(buildMuseViewMcp({ mcpServers: {} })).toEqual({ flags: [], env: {}, skipped: [] });
  });
});
