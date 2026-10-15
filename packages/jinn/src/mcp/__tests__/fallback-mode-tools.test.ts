import { describe, expect, it } from "vitest";
import { buildTools } from "../server.js";
import type { JinnMcpContext } from "../toolkit.js";

/** `fallbackMode` on `delegate_task` and `spawn_session`: an enum on the schema, forwarded to the gateway when given, left out when not. */

interface SeenCall { url: string; body?: Record<string, unknown> }

function stub(response: unknown) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return { status: 201, text: async () => JSON.stringify(response) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:7777", fetchFn, callerSessionId: "caller-1", sessionCapability: "cap-test" };
  return { calls, ctx };
}

const tool = (name: string) => {
  const found = buildTools().find((t) => t.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

describe.each([
  ["delegate_task", { task: "t", employee: "e" }, "/api/delegations", { workItemId: "wi_1", sessionId: "s-1", engine: "codex", status: "running" }],
  ["spawn_session", { prompt: "p" }, "/api/sessions", { id: "s-1", engine: "codex", status: "running" }],
] as const)("%s fallbackMode", (name, base, route, response) => {
  it("is an optional enum of the three modes, with one description", () => {
    const schema = tool(name).inputSchema as { required?: string[]; properties: Record<string, { enum?: string[]; description?: string }> };
    expect(schema.properties.fallbackMode.enum).toEqual(["fallback", "fallback-children", "auto-resume"]);
    expect(schema.properties.fallbackMode.description).toMatch(/auto-resume \(never switch model\)/);
    expect(schema.required).not.toContain("fallbackMode");
  });

  it.each(["fallback", "fallback-children", "auto-resume"])("forwards %s to the gateway", async (mode) => {
    const { calls, ctx } = stub(response);
    await tool(name).handler({ ...base, fallbackMode: mode }, ctx);
    expect(calls[0].url).toBe(`http://127.0.0.1:7777${route}`);
    expect(calls[0].body).toMatchObject({ fallbackMode: mode });
  });

  it("leaves it out of the request when not given, so the gateway's inheritance rule applies", async () => {
    const { calls, ctx } = stub(response);
    await tool(name).handler({ ...base }, ctx);
    expect(calls[0].body).not.toHaveProperty("fallbackMode");
  });
});
