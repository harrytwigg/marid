import { describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": everything derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));
vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: () => ({}) }));

import type { ResolvedMcpConfig } from "../../shared/types.js";
import { buildMuseViewMcp } from "../musecode-view-args.js";
import { ctx, opts, sent, useFakeMuse } from "./helpers/fake-muse-harness.js";

useFakeMuse();

describe("a build with another codename", () => {
  it("introduces itself to Muse under that name", async () => {
    await ctx.engine.run(opts());
    expect(sent("initialize")[0]).toMatchObject({ clientInfo: { name: "acme" } });
  });

  it("carries the view's MCP values in variables under that name's prefix", () => {
    const resolvedMcp = { mcpServers: { s: { command: "/bin/x", env: { A: "1" } } } } as unknown as ResolvedMcpConfig;
    const { flags, env } = buildMuseViewMcp(resolvedMcp);
    expect(Object.keys(env)).toEqual(["ACME_MCP_1"]);
    expect(flags[1]).toContain("${ACME_MCP_1}");
  });
});
