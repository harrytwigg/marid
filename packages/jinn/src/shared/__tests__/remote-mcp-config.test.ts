import { describe, expect, it } from "vitest";
import { remoteMcpProblems, resolveRemoteMcpAuth } from "../remote-mcp-config.js";

const complete = { enabled: true, access: { teamDomain: "team.example.com", aud: "aud-1" }, allowedEmails: ["Op@Example.com "] };

describe("gateway.remoteMcp config", () => {
  it("accepts an absent block, a disabled one without a resourceUrl, and a complete one", () => {
    expect(remoteMcpProblems(undefined)).toEqual([]);
    expect(remoteMcpProblems({ enabled: false })).toEqual([]);
    expect(remoteMcpProblems({ ...complete, resourceUrl: "https://gw.example.com/mcp", deniedEmails: [], allowedOrigins: [] })).toEqual([]);
  });

  it.each([
    [[], "must be a mapping"],
    [{ enabled: "yes" }, "enabled must be a boolean"],
    [{ resourceUrl: "http://gw.example.com/mcp" }, "resourceUrl must be an https URL"],
    [{ access: { teamDomain: "https://team.example.com" } }, "bare host name"],
    [{ access: { aud: "" } }, "AUD tag"],
    [{ allowedEmails: "op@example.com" }, "allowedEmails must be a list of strings"],
    [{ enabled: true }, "resourceUrl is required when enabled"],
  ])("reports %j", (block, fragment) => {
    expect(remoteMcpProblems(block).join("\n")).toContain(fragment);
  });

  it("resolves verification settings only when they are complete (FR-003 fails closed)", () => {
    expect(resolveRemoteMcpAuth(complete)?.allowedEmails).toEqual(new Set(["op@example.com"]));
    expect(resolveRemoteMcpAuth({ ...complete, allowedEmails: [] })).toBeUndefined();
    expect(resolveRemoteMcpAuth({ ...complete, access: { teamDomain: "team.example.com" } })).toBeUndefined();
    expect(resolveRemoteMcpAuth(undefined)).toBeUndefined();
  });
});
